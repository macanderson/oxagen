import { createFunction } from "../create-function";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { generateObjectFor, selectModelForOrg } from "@oxagen/ai";
import { CREDIT_REASONS } from "@oxagen/billing";
import { z } from "zod";
import { logger } from "../logger";
import { countOf } from "../lib/driver-count";

// ── Pure helper — exported for unit testing ────────────────────────────────────

/**
 * An empty property bag with a NULL PROTOTYPE, for any map whose keys come from
 * a schema or from a customer's own graph.
 *
 * `{}` inherits `Object.prototype`, which carries an accessor named
 * `__proto__`. Assigning through it — `bag["__proto__"] = null` — invokes the
 * legacy prototype SETTER instead of creating an own property, so the key is
 * silently absent from `Object.keys`, absent from what the Bolt driver
 * serialises, and absent from `JSON.stringify`. In a prune that means the
 * removal instruction never reaches Neo4j: the property stays on the edge while
 * the job increments `prunedRelationships` and reports success. A mechanism
 * that reports success without doing the thing is the whole failure mode this
 * builder exists to prevent, and this is the quietest instance of it — the only
 * evidence is a property that is still there.
 *
 * Both key sources are free-form: `schema.property.upsert` accepts any
 * non-empty name up to 200 characters, and a customer's Neo4j properties are
 * theirs to name. The node path is demonstrably reachable without either:
 * `JSON.parse` creates `__proto__` as an OWN property (it defines rather than
 * assigns), so a node whose canonical `properties` JSON contains that key hands
 * one straight to {@link buildPrunedProperties}.
 *
 * Fixed at the CONSTRUCTION, not at the key. `__proto__` is the only name with
 * an inherited setter — `constructor` and `prototype` are ordinary own keys —
 * but special-casing it would leave the next reader reasoning about which names
 * are dangerous and maintaining a list. A null prototype inherits nothing, so
 * there is no list and no next name.
 */
function emptyPropertyBag(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Build the pruned properties map: returns only the properties whose keys
 * appear in `schemaKeys`. Removed keys are returned in `removedKeys`.
 *
 * Direction-agnostic: downgrading to an older schema version with prune=true
 * removes properties that a prior forward-heal added but aren't in the older schema.
 */
export function buildPrunedProperties(
  existing: Record<string, unknown>,
  schemaKeys: string[],
  reservedKeys: ReadonlySet<string> = EMPTY_RESERVED,
): { pruned: Record<string, unknown>; removedKeys: string[] } {
  const schemaKeySet = new Set(schemaKeys);
  const pruned: Record<string, unknown> = emptyPropertyBag();
  const removedKeys: string[] = [];

  for (const [key, value] of Object.entries(existing)) {
    if (schemaKeySet.has(key) || reservedKeys.has(key)) {
      pruned[key] = value;
    } else {
      removedKeys.push(key);
    }
  }

  return { pruned, removedKeys };
}

const EMPTY_RESERVED: ReadonlySet<string> = new Set<string>();

/**
 * Relationship properties the PLATFORM owns on an ORGANISATION'S OWN edges.
 *
 * They never appear in a user schema, so a prune pass computed from schema keys
 * alone classifies every one of them as off-schema. That was harmless only
 * while the write merged (`SET r += $props`), which cannot delete. The moment
 * the write gained removal semantics, pruning a relationship would have
 * stripped its bi-temporal history (`validFrom`, `validTo`, `recordedAt`,
 * `invalidatedAt`) and its tenancy stamp (`orgId`, `workspaceId`) — strictly
 * worse than the bug being fixed.
 *
 * This set is deliberately NOT the whole defence, and must not be read as the
 * closed list of platform-owned relationship properties. There is no such list:
 * nothing registers, types or checks the properties an edge writer puts on a
 * relationship, so `ALIAS_OF` carries `confidence`/`matchReason`/`tentative`
 * (packages/ingestion/src/mutations/upsert-entity.ts), `ABOUT` carries
 * `role`/`weight` and `INVOKED` carries `callCount`/`failedCallCount`/
 * `firstInvokedAt`/`lastInvokedAt` (packages/agent), and every one of those
 * would be off-schema here. An enumerated list of names is a set that can only
 * ever be too narrow, which is the failure this file has now hit twice.
 *
 * The defence that closes the class is {@link NON_SYSTEM_RELATIONSHIP_FILTER}:
 * platform-owned edges are excluded from schema reconciliation altogether. This
 * set remains for the edges reconciliation DOES touch — an organisation's own
 * relationships, which carry the tenancy and temporal stamps above.
 */
export const RESERVED_RELATIONSHIP_PROPERTY_KEYS: ReadonlySet<string> = new Set(
  [
    "orgId",
    "workspaceId",
    "is_system",
    "createdAt",
    "updatedAt",
    "validFrom",
    "validTo",
    "recordedAt",
    "invalidatedAt",
  ],
);

/**
 * The relationship types this platform writes between two `:GraphNode`s, made
 * executable rather than left in prose.
 *
 * This is the enumeration argued for below, not a sample of it: thirteen Cypher
 * sites in this repository create a relationship, only four can produce one
 * between two `:GraphNode`s, and relationship types cannot be parameterized in
 * Cypher, so the set of type NAMES a platform writer can emit is fixed at
 * compile time. Adding a fifth platform writer means adding its type here; the
 * test beside this constant pins the list against the doc comment so the two
 * cannot drift silently.
 */
export const PLATFORM_RELATIONSHIP_TYPES: readonly string[] = [
  "ABOUT",
  "ALIAS_OF",
  "INVOKED",
  "REMEMBERS",
];

/** Parameter carrying {@link PLATFORM_RELATIONSHIP_TYPES} into the filter. */
export const PLATFORM_REL_TYPES_PARAM = "platformRelTypes";

/**
 * Spread into the params of EVERY query that embeds
 * {@link NON_SYSTEM_RELATIONSHIP_FILTER}. A list parameter rather than
 * interpolated Cypher text, which keeps {@link RELATIONSHIP_WRITE_BACK_CYPHER}
 * the constant its own doc comment claims it is.
 */
export const PLATFORM_REL_TYPE_PARAMS: Readonly<Record<string, unknown>> = {
  [PLATFORM_REL_TYPES_PARAM]: PLATFORM_RELATIONSHIP_TYPES,
};

/**
 * Tenant anchoring for the FAR endpoint of a two-endpoint relationship match.
 *
 * `publicId` identifies WHICH node. It does not establish WHOSE — they are
 * different questions, and the endpoint re-identification that defeats
 * element-id reuse answers only the first. A legacy, imported or BYO graph can
 * hold an edge from an in-scope `a` to a `b` belonging to another organisation,
 * or to another workspace of the same organisation; anchoring `a` alone matches
 * it. `SET r += $props` carries null-valued removals, so what follows is
 * properties DELETED off another tenant's edge.
 *
 * Both halves are load-bearing and neither implies the other: an org check
 * passes for every workspace in that org, and a workspace id is not unique
 * across orgs. `graph.stats.ts` and `reference.search.ts` already anchor both
 * endpoints on exactly this shape — this file was the outlier, not the pattern.
 *
 * WHY ONLY THE FAR ENDPOINT IS A CONSTANT, and `a`'s anchor stays written out
 * at each site: `tenant.scope-guard.test.ts` walks this repository, extracts
 * every Cypher literal handed to a scoped `.run()`, and asserts the tenancy
 * guard still accepts it. It reads the STATIC text, so a template hole is
 * opaque to it — folding `a.orgId = $orgId` into a constant made three real
 * queries read as binding no tenant at all and turned that corpus test red.
 * The anchor the corpus checks for therefore stays visible in the query, and
 * only the new predicate is shared. A DRY win is not worth blinding the test
 * that exists to catch an unanchored query at authoring time.
 */
export const FAR_ENDPOINT_TENANT_FILTER = `b.orgId = $orgId AND b.workspaceId = $workspaceId`;

/**
 * The predicate that keeps reconciliation off edges it could never write back.
 *
 * {@link RELATIONSHIP_WRITE_BACK_CYPHER} re-identifies its target by
 * `a.publicId = $startId AND b.publicId = $endId`, because an element id is not
 * an identity across the transaction gap between the batch read and the write.
 * That re-identification needs the endpoints to HAVE a publicId, and nothing
 * guarantees they do: `graph_node_public_id` is
 * `FOR (n:GraphNode) REQUIRE n.publicId IS UNIQUE`
 * (packages/ontology/src/schema.cypher), and a Neo4j uniqueness constraint
 * simply ignores a node that lacks the property — it is not an existence
 * constraint, which is Enterprise-only. Every writer IN THIS REPOSITORY sets
 * `publicId`, but the legacy / imported / BYO graph this file already anchors
 * both endpoints against is exactly the graph that can hold one that does not.
 *
 * WITHOUT THIS FILTER the failure is silent and expensive, in that order:
 * `startId` comes back null, `a.publicId = $startId` compares against a null
 * parameter, Cypher's three-valued logic makes that NULL rather than true, the
 * write matches zero rows — and the loop logs a warning, counts nothing as
 * updated, and STILL advances `processedRelationships`. The job then finalises
 * with `processedRelationships == totalRelationships`: a reconcile that reports
 * completion having applied nothing to those rows. It also pays for them, since
 * the AI derivation for missing required properties runs BEFORE the write-back
 * that is going to refuse it.
 *
 * Excluding at SELECTION rather than loosening the write-back is deliberate.
 * A null-tolerant re-identification (`($startId IS NULL AND a.publicId IS NULL)
 * OR a.publicId = $startId`) would make the write land, but it would land on
 * the strength of "this endpoint has no id either" — which re-identifies
 * nothing, and re-opens the element-id-reuse hole the whole re-identification
 * exists to close. An edge that cannot be safely re-identified is out of scope
 * for reconciliation, and saying so is better than half-doing it.
 *
 * It is applied to the COUNT as well as the read, so `totalRelationships`
 * describes the work that will actually be attempted, and the excluded rows are
 * counted separately and logged rather than disappearing. See
 * {@link UNRECONCILABLE_RELATIONSHIP_COUNT} for the projection that reports them.
 */
export const REIDENTIFIABLE_ENDPOINTS_FILTER = `a.publicId IS NOT NULL AND b.publicId IS NOT NULL`;

/**
 * The count projection that makes the exclusion above visible.
 *
 * `count(CASE WHEN … END)` counts only non-null results, so this yields the
 * number of in-tenant, in-schema edges that {@link REIDENTIFIABLE_ENDPOINTS_FILTER}
 * removes from the run. Reported so an operator can tell "there was nothing to
 * reconcile" from "there were rows this job refused to touch".
 */
export const UNRECONCILABLE_RELATIONSHIP_COUNT = `count(CASE WHEN a.publicId IS NULL OR b.publicId IS NULL THEN 1 END)`;

/**
 * The predicate that keeps schema reconciliation off PLATFORM-OWNED edges.
 *
 * Reconciliation exists to make an organisation's own graph conform to the
 * schema that organisation pinned. A platform edge is not that: `ALIAS_OF`
 * records how ingestion deduplicated two entities, `INVOKED` records what an
 * execution called, `ABOUT`/`REMEMBERS` wire agent memory to the graph. None of
 * them is described by a user schema, and a pinned schema that happens to NAME
 * one of those types — `ALIAS_OF` is an ordinary-looking relationship type —
 * drags the whole family into the prune, where the explicit removal now deletes
 * the operational metadata the platform runs on.
 *
 * Excluding them is preferred to widening the reserved-key set because the set
 * of platform-owned relationship PROPERTIES is open (see
 * {@link RESERVED_RELATIONSHIP_PROPERTY_KEYS}) while the set of platform-owned
 * relationship WRITERS is closed and small. Thirteen Cypher sites in this
 * repository create a relationship; only four can produce one between two
 * `:GraphNode`s, which is the only shape this MATCH can reach:
 *
 *   - `ALIAS_OF`   packages/ingestion/src/mutations/upsert-entity.ts
 *                  packages/inngest-functions/src/functions/ingestion.delete.ts
 *   - `REMEMBERS`  packages/agent/src/memory/neo4j.ts
 *   - `ABOUT`      packages/agent/src/memory/neo4j.ts
 *   - `INVOKED`    packages/agent/src/dispatch/tool-projection.ts
 *
 * (The rest — `PROMOTED`, `DEMOTED`, `BASED_ON`, `CITED`, `OF`, `SUPPORTS`,
 * `REFUTES` — hang off `:Promotion` / `:Demotion` / `:Citation` / `:Evidence`
 * nodes, which never receive the `:GraphNode` anchor label, so the reconcile
 * MATCH cannot bind them.) All four set `is_system = true` on the relationship
 * as of this change — which is a statement about what they write from here on,
 * not about what a customer's graph already holds; see THE TYPE EXCLUSION below.
 *
 * The enumeration is the whole set, not a sample: relationship types cannot be
 * parameterized in Cypher, and `sanitizeRelationshipType` — the one coercion
 * that would let a non-constant type be interpolated — has no production caller.
 * So no code path in this repository writes a `:GraphNode`-to-`:GraphNode`
 * relationship that is not platform-owned. A relationship this pass legitimately
 * reconciles therefore comes from an organisation writing into its OWN graph
 * endpoint (BYO Neo4j is a design constraint, not an add-on) — which is exactly
 * the case schema reconciliation exists for, and exactly the case where
 * mistaking a platform edge for user data destroys something.
 *
 * Three parts, each load-bearing, in order of what they can reach.
 *
 * THE TYPE EXCLUSION reaches edges ALREADY IN THE GRAPH. Marking the writers is
 * a write-path fix: it settles what future edges look like and says nothing
 * about the ones a customer's graph is holding right now. `ingestion.delete`'s
 * alias-promotion reroute wrote `ALIAS_OF` edges WITHOUT `is_system` — it is
 * fixed in this same change, but every edge that query already created carries
 * no marker, and both `EntityNode` endpoints carry `is_system = false`, so the
 * flag predicates read those edges as customer data. An organisation that pins
 * an `ALIAS_OF` schema and reconciles with `prune=true` would then have
 * `matchReason` and `tentative` deleted, permanently, by the null-valued
 * write-back. The type is the only property of such an edge that does not
 * depend on when it was written, so the type is what excludes it.
 *
 * A backfill was the alternative and is strictly weaker HERE. It could only
 * identify the unmarked edges by the same enumeration this list carries, so it
 * buys no discrimination the exclusion does not already have; it is a mutation
 * across customer data that a maintainer has to run before the guarantee holds;
 * and BYO Neo4j is a design constraint, not an add-on, so a platform-run
 * migration cannot reach the endpoints most at risk. The exclusion needs
 * nothing run and protects every graph the moment it ships.
 *
 * It is deliberately over-broad in the safe direction. A customer who writes
 * their own `:GraphNode`-to-`:GraphNode` edge NAMED `ALIAS_OF` has it skipped
 * by reconciliation — the schema is not applied to it, which is recoverable and
 * visible. The failure it replaces is the permanent deletion of platform
 * metadata, which is neither.
 *
 * THE RELATIONSHIP FLAG is the direct marker on edges written by a writer that
 * sets it, and it still covers a platform edge type this list has not yet
 * learned about. THE ENDPOINT FLAGS are the backstop for an edge writer that
 * forgets both. `coalesce(…, false)` because an edge or node predating a writer
 * that sets the flag has it absent, not false.
 */
export const NON_SYSTEM_RELATIONSHIP_FILTER = `NOT type(r) IN $${PLATFORM_REL_TYPES_PARAM}
               AND coalesce(r.is_system, false) = false
               AND coalesce(a.is_system, false) = false
               AND coalesce(b.is_system, false) = false`;

/**
 * The relationship write-back, in full. It is a CONSTANT: no property name and
 * no key of any kind is interpolated into it, which is what makes the property
 * names in {@link buildRelationshipWriteBackProps} unable to be parsed as
 * Cypher (see that function for the escape that defeats quoting).
 *
 * The write is anchored to the SAME tenant the batch read anchored to. An
 * elementId is a global graph address, so an unanchored `MATCH ()-[r]->()`
 * would write any relationship in the store whose id happened to collide — and
 * it would never run at all, because the scoped-session tenancy guard rejects
 * Cypher that binds no orgId. `$orgId`/`$workspaceId` are injected by the seam.
 *
 * AND THE ELEMENT ID IS NOT AN IDENTITY. Neo4j's manual is explicit: an element
 * id "is unique … within the scope of a single transaction", and "outside of
 * the scope of a single transaction, no guarantees are given about the mapping
 * between ID values and elements. Neo4j reuses its internal IDs when nodes and
 * relationships are deleted." Every `session.run` on a scoped session is its own
 * AUTO-COMMIT transaction, so the batch read and this write are already in
 * different transactions — and the gap between them is not microseconds. The
 * per-row loop makes an LLM call to derive missing required properties, bounded
 * at 30s, for up to 50 rows a batch. If a relationship is deleted in that window
 * and another takes its id, this write lands on the replacement. `SET r += $props`
 * carries NULL-VALUED REMOVALS, so the damage is not wrong data: it is
 * properties DELETED off a relationship nobody meant to touch.
 *
 * The strong remedy is one transaction around the read and the writes. It is not
 * available at this batch shape: holding a write transaction open across 50
 * LLM round-trips is up to 25 minutes of retained locks, well past any sane
 * transaction timeout, and `scopedSession()` deliberately exposes only `run` —
 * a transaction API would mean reopening the tenancy seam that carries the
 * bypass guard. So the write RE-IDENTIFIES instead, against data the read
 * already returned and that the element id cannot fake:
 *
 *  - `type(r) = $relType`. A relationship type is immutable, and the removals in
 *    `$props` were computed from THAT type's schema, so a different type makes
 *    the write nonsense by construction.
 *  - `a.publicId = $startId AND b.publicId = $endId`. `publicId` is
 *    application-generated and carries a uniqueness constraint
 *    (`graph_node_public_id`), which is exactly what the manual recommends
 *    relying on instead of an internal id. With the pattern's direction it pins
 *    the write to one ordered node pair.
 *
 * The residual, stated rather than implied: Neo4j permits more than one
 * relationship of the same type between the same ordered pair, so a reused id
 * landing on a SIBLING relationship still matches. That is a far smaller target
 * than "any relationship in this tenant", and it is the limit of what can be
 * keyed on without a relationship-level application id.
 *
 * `RETURN count(r) AS written` is the other half. A verification that silently
 * skips is the same defect in a new place — the job would report a prune it did
 * not perform — so the caller counts only what this query says it matched.
 */
export const RELATIONSHIP_WRITE_BACK_CYPHER = `MATCH (a:GraphNode)-[r]->(b:GraphNode)
   WHERE elementId(r) = $relElemId
     AND a.orgId = $orgId AND a.workspaceId = $workspaceId
     AND ${FAR_ENDPOINT_TENANT_FILTER}
     AND type(r) = $relType
     AND a.publicId = $startId AND b.publicId = $endId
     AND ${NON_SYSTEM_RELATIONSHIP_FILTER}
   SET r += $props
   RETURN count(r) AS written`;

/**
 * Remove every reserved key from a relationship property bag.
 *
 * Reconciliation's only job is an organisation's OWN properties. These keys are
 * the platform's — tenancy, the bi-temporal bounds, and `is_system` — and two
 * of the ways into this bag are not the organisation:
 *
 *  - `derivedProps` is typed `z.record(z.unknown())`, so the model may return
 *    ANY key, including ones nobody asked for. Model output is untrusted data,
 *    not an author's intent.
 *  - `schema.property.upsert` accepts any non-empty name up to 200 characters
 *    (`key: z.string().min(1).max(200)`), so a schema may legitimately DECLARE
 *    `is_system`, and a declared-required-with-description key is exactly what
 *    the derivation prompt asks the model to invent.
 *
 * Both were checked at source and both are reachable. They meet here, which is
 * why the fix is here rather than at either of them.
 *
 * WHAT IT PREVENTS, and the second harm is the worse one. A customer edge that
 * acquires `is_system = true` is excluded from every later reconciliation by
 * {@link NON_SYSTEM_RELATIONSHIP_FILTER} — visible if anyone looks. But that
 * filter is also part of the predicate the BATCH SELECTION runs, and the batch
 * is paginated with `SKIP`. Shrink the result set while the offset advances and
 * rows slide past it unvisited: relationships the job promises to reconcile are
 * silently never processed, with no error, no counter and nothing in the log.
 *
 * Stripping makes that structural rather than incidental. The relationship
 * write is `SET r += $props` and touches only `r`; the selection predicate
 * reads `type(r)` (immutable), the endpoints' tenancy and `is_system` (the
 * write never touches a node), and `r.is_system`. With reserved keys gone from
 * `$props`, THE LOOP'S OWN WRITES CANNOT CHANGE ITS OWN SELECTION PREDICATE —
 * which is the property that makes paginating over it safe from itself.
 *
 * It does not make `SKIP` pagination safe from everything, and this comment
 * does not claim it: a concurrent writer and the absence of a total order are
 * both still there. See the ORDER BY and the note on the batch read.
 *
 * NODE property bags are deliberately NOT stripped. A node's properties are a
 * JSON string, so `createdAt` or `orgId` inside that bag is ordinary customer
 * data rather than a graph property — which is the same reason
 * `buildPrunedProperties` is called without a reserved set on the node path.
 */
export function stripReservedRelationshipKeys(bag: Record<string, unknown>): {
  kept: Record<string, unknown>;
  stripped: string[];
} {
  const kept = emptyPropertyBag();
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (RESERVED_RELATIONSHIP_PROPERTY_KEYS.has(key)) stripped.push(key);
    else kept[key] = value;
  }
  return { kept, stripped };
}

/**
 * Build the parameter map for one relationship's write-back.
 *
 * `SET r += $props` MERGES: a key omitted from the map stays on the
 * relationship. So pruning that only omits keys removes nothing while the job
 * increments `prunedRelationships` and reports success — the counter would have
 * looked healthy for work that never happened. Removal has to be STATED.
 *
 * It is stated as DATA, not as query text. Cypher has no parameter form for a
 * property name, so the obvious spelling of removal — `REMOVE r.\`key\`` — has
 * to interpolate the key, and no amount of escaping makes that safe. Escaping
 * doubles a literal backtick; Cypher then decodes `\uXXXX` escapes inside the
 * quoted name at PARSE time, i.e. after the doubling has run, so a key carrying
 * the six ASCII characters `\u0060` becomes a real backtick that terminates the
 * identifier and appends whatever follows it as Cypher. `schema.property.upsert`
 * accepts any non-empty string up to 200 characters, so such a key is a legal
 * input that reconciliation itself can write through the parameterized property
 * map before a later prune reads it back. Normalising that one escape would
 * leave the next encoding to find; the whole class closes only when the name
 * stops being query text.
 *
 * Neo4j gives exactly that form: in a `+=` map, "if any property in the map is
 * `null`, it will be removed from the node or relationship" (Cypher manual,
 * SET). So a removed key rides in `$props` with a `null` value, the Cypher is
 * the constant {@link RELATIONSHIP_WRITE_BACK_CYPHER}, and a property name is
 * never parsed as anything but a map key.
 *
 * This keeps the property the enumerated `REMOVE` was chosen for: deleting a
 * property still requires NAMING it. Replacement (`SET r = $props`) is what
 * silently deletes when a key is missing from the reserved set, and that is
 * still not what this does.
 */
export function buildRelationshipWriteBackProps(
  retained: Record<string, unknown>,
  removedKeys: readonly string[],
): Record<string, unknown> {
  const props: Record<string, unknown> = emptyPropertyBag();
  // A RETAINED key is omitted when its value is null or undefined, because
  // `null` is this map's removal instruction and a retained key must not carry
  // one. Omitting it is also the correct semantics on its own terms: `+=`
  // merges, so a key the map does not mention is left exactly as it is, which
  // is what "retain" means. Neo4j cannot store a null property value, so a
  // null here is never the graph's own state — it is an AI-derived property
  // the model returned as null, or a caller-supplied bag. Either way it must
  // not delete anything.
  // Reserved keys never ride the write. `+=` MERGES, so a key the map does not
  // mention is left exactly as it is — which is what "retain" means, and is
  // strictly better than re-writing the value the read happened to see. This is
  // the chokepoint, so the invariant holds whatever put the key in the bag.
  for (const [key, value] of Object.entries(
    stripReservedRelationshipKeys(retained).kept,
  )) {
    if (value !== null && value !== undefined) props[key] = value;
  }
  for (const key of removedKeys) {
    // The one key a property map cannot express, and the one this platform
    // cannot have authored: `schema.property.upsert` requires a non-empty name.
    // Kept as a throw rather than a skip — skipping is how a prune reports
    // success having removed nothing, which is the defect this builder fixes.
    if (key.length === 0) {
      throw new Error(
        "schema.reconcile: an empty relationship property key cannot be pruned",
      );
    }
    props[key] = null;
  }
  return props;
}

/**
 * Parse a KnowledgeNode's `properties` column into a plain object.
 *
 * Canonical storage (see graph.node.upsert) serializes the property bag to a
 * JSON STRING — Neo4j node property values must be primitives/arrays, never a
 * map. Read with this helper and write back with `JSON.stringify(...)` to
 * stay consistent with ingestion. Also accepts an already-parsed object,
 * since some callers may hand one in directly.
 */
export function parseNodeProps(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  return {};
}

// ── Batch size ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;

// Per-node / per-relationship AI derivation wall-clock cap. The AI gateway can
// stall indefinitely; without a bound the whole reconcile step hangs and the
// job is stuck "running" forever (the try/catch around the call cannot rescue a
// hang — only a throw). AbortSignal.timeout turns a stall into an AbortError the
// existing catch handles, letting the worker skip that node and continue.
const AI_DERIVE_TIMEOUT_MS = 30_000;

// ── Reconcile state shape ─────────────────────────────────────────────────────

interface ReconcileState {
  totalNodes: number;
  processedNodes: number;
  updatedNodes: number;
  totalRelationships: number;
  processedRelationships: number;
  updatedRelationships: number;
  prune: boolean;
  prunedNodes: number;
  prunedRelationships: number;
  prunedPropertyKeys: Record<string, string[]>;
}

// ── Inngest function ──────────────────────────────────────────────────────────

export const [schemaReconcile] = createFunction(
  {
    id: "schema-reconcile",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "schema/reconcile.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, executionId, versionId, prune } =
      event.data as {
        orgId: string;
        workspaceId: string;
        executionId: string;
        versionId: string;
        prune: boolean;
      };

    // ── Step: mark the execution as running ────────────────────────────────────
    await step.run("start", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(db.agentExecutions)
            .set({ status: "running", startedAt: new Date() })
            .where(
              and(
                eq(db.agentExecutions.id, executionId),
                eq(db.agentExecutions.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // ── Step: load the target schema definition from DB ────────────────────────
    const schemaDefinition = await step.run("load-schema", async () => {
      return runInTenantScope({ orgId, workspaceId }, async () => {
        // Resolve version row by publicId.
        const versionRow = await withTenantDb((tx) =>
          tx.query.schemaVersions.findFirst({
            where: and(
              eq(db.schemaVersions.publicId, versionId),
              eq(db.schemaVersions.orgId, orgId),
              eq(db.schemaVersions.workspaceId, workspaceId),
            ),
            columns: { id: true, versionNumber: true },
          }),
        );

        if (!versionRow) {
          throw new Error(
            `schema.reconcile: schema version not found: ${versionId}`,
          );
        }

        // Load all schemas belonging to this version.
        const allSchemas = await withTenantDb((tx) =>
          tx.query.schemas.findMany({
            where: and(
              eq(db.schemas.versionId, versionRow.id),
              eq(db.schemas.orgId, orgId),
              eq(db.schemas.workspaceId, workspaceId),
              isNull(db.schemas.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        if (allSchemas.length === 0) {
          logger.info(
            { orgId, workspaceId, versionId },
            "schema.reconcile: no schemas in target version",
          );
          return {
            versionInternalId: versionRow.id,
            labelNames: [] as string[],
            relTypeNames: [] as string[],
            labelSchemaMap: {} as Record<
              string,
              {
                labelId: string;
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
            relTypeSchemaMap: {} as Record<
              string,
              {
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
          };
        }

        // Load schema activations to determine enabled schemas.
        const activations = await withTenantDb((tx) =>
          tx.query.schemaActivations.findMany({
            where: and(
              eq(db.schemaActivations.orgId, orgId),
              eq(db.schemaActivations.workspaceId, workspaceId),
              isNull(db.schemaActivations.deletedAt),
            ),
            columns: { schemaName: true, enabled: true },
          }),
        );

        const activationMap = new Map(
          activations.map((a) => [a.schemaName, a.enabled]),
        );
        // Schemas with no activation record are enabled by default.
        const enabledSchemaIds = allSchemas
          .filter((s) => activationMap.get(s.name) !== false)
          .map((s) => s.id);

        if (enabledSchemaIds.length === 0) {
          return {
            versionInternalId: versionRow.id,
            labelNames: [] as string[],
            relTypeNames: [] as string[],
            labelSchemaMap: {} as Record<
              string,
              {
                labelId: string;
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
            relTypeSchemaMap: {} as Record<
              string,
              {
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
          };
        }

        // Load node labels for enabled schemas.
        const labels = await withTenantDb((tx) =>
          tx.query.nodeLabels.findMany({
            where: and(
              eq(db.nodeLabels.versionId, versionRow.id),
              inArray(db.nodeLabels.schemaId, enabledSchemaIds),
              eq(db.nodeLabels.orgId, orgId),
              isNull(db.nodeLabels.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        // Load relationship types for enabled schemas.
        const relTypes = await withTenantDb((tx) =>
          tx.query.relationshipTypes.findMany({
            where: and(
              eq(db.relationshipTypes.versionId, versionRow.id),
              inArray(db.relationshipTypes.schemaId, enabledSchemaIds),
              eq(db.relationshipTypes.orgId, orgId),
              isNull(db.relationshipTypes.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        // Load properties for all labels and rel types.
        const allProperties = await withTenantDb((tx) =>
          tx.query.schemaProperties.findMany({
            where: and(
              eq(db.schemaProperties.versionId, versionRow.id),
              eq(db.schemaProperties.orgId, orgId),
              isNull(db.schemaProperties.deletedAt),
            ),
            columns: {
              id: true,
              nodeLabelId: true,
              relationshipTypeId: true,
              key: true,
              dataType: true,
              required: true,
              description: true,
            },
          }),
        );

        // Build label schema map (plain object, Inngest step results must be serializable).
        const labelSchemaMap: Record<
          string,
          {
            labelId: string;
            properties: Array<{
              key: string;
              dataType: string;
              required: boolean;
              description: string | null;
            }>;
          }
        > = {};
        for (const label of labels) {
          const props = allProperties
            .filter((p) => p.nodeLabelId === label.id)
            .map((p) => ({
              key: p.key,
              dataType: p.dataType,
              required: p.required,
              description: p.description,
            }));
          labelSchemaMap[label.name] = { labelId: label.id, properties: props };
        }

        // Build rel type schema map.
        const relTypeSchemaMap: Record<
          string,
          {
            properties: Array<{
              key: string;
              dataType: string;
              required: boolean;
              description: string | null;
            }>;
          }
        > = {};
        for (const relType of relTypes) {
          const props = allProperties
            .filter((p) => p.relationshipTypeId === relType.id)
            .map((p) => ({
              key: p.key,
              dataType: p.dataType,
              required: p.required,
              description: p.description,
            }));
          relTypeSchemaMap[relType.name] = { properties: props };
        }

        return {
          versionInternalId: versionRow.id,
          labelNames: labels.map((l) => l.name),
          relTypeNames: relTypes.map((r) => r.name),
          labelSchemaMap,
          relTypeSchemaMap,
        };
      });
    });

    // Exit early if there are no labels to reconcile.
    if (
      schemaDefinition.labelNames.length === 0 &&
      schemaDefinition.relTypeNames.length === 0
    ) {
      await step.run("complete-empty", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(db.agentExecutions)
              .set({
                status: "completed",
                completedAt: new Date(),
                outputPayload: {
                  totalNodes: 0,
                  processedNodes: 0,
                  updatedNodes: 0,
                  totalRelationships: 0,
                  processedRelationships: 0,
                  updatedRelationships: 0,
                  prunedNodes: 0,
                  prunedRelationships: 0,
                },
              })
              .where(eq(db.agentExecutions.id, executionId)),
          ),
        ),
      );
      return {
        executionId,
        status: "completed",
        totalNodes: 0,
        totalRelationships: 0,
      };
    }

    // ── Step: count total nodes and relationships to reconcile ─────────────────
    const counts = await step.run("count-nodes", async () => {
      return runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();

        let totalNodes = 0;
        let totalRelationships = 0;

        if (schemaDefinition.labelNames.length > 0) {
          const nodeResult = await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND n.label IN $labels
             RETURN count(n) AS total`,
            { orgId, workspaceId, labels: schemaDefinition.labelNames },
          );
          totalNodes = countOf(nodeResult.records[0]?.get("total"));
        }

        if (schemaDefinition.relTypeNames.length > 0) {
          const relResult = await session.run(
            // Platform-owned edges are excluded here as well as in the
            // reconcile pass, so `totalRelationships` counts the work that is
            // actually going to be done. A total that includes rows the pass
            // skips reports a reconcile as incomplete forever.
            `MATCH (a:GraphNode)-[r]->(b:GraphNode)
             WHERE a.orgId = $orgId AND a.workspaceId = $workspaceId
               AND ${FAR_ENDPOINT_TENANT_FILTER}
               AND type(r) IN $relTypes
               AND ${NON_SYSTEM_RELATIONSHIP_FILTER}
             RETURN count(r) AS total,
                    ${UNRECONCILABLE_RELATIONSHIP_COUNT} AS unreconcilable`,
            {
              orgId,
              workspaceId,
              relTypes: schemaDefinition.relTypeNames,
              ...PLATFORM_REL_TYPE_PARAMS,
            },
          );
          // The COUNT is deliberately unfiltered by REIDENTIFIABLE_ENDPOINTS_FILTER
          // and subtracts instead, so the rows the run will not attempt are a
          // number an operator can see rather than an absence they cannot.
          const matched = countOf(relResult.records[0]?.get("total"));
          const unreconcilable = countOf(
            relResult.records[0]?.get("unreconcilable"),
          );
          totalRelationships = matched - unreconcilable;
          if (unreconcilable > 0) {
            logger.warn(
              { orgId, workspaceId, executionId, unreconcilable, matched },
              "schema.reconcile: relationships excluded — an endpoint carries no publicId, so the write-back could not re-identify them",
            );
          }
        }

        return { totalNodes, totalRelationships };
      });
    });

    // Update state with totals.
    await step.run("update-state-counts", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(db.agentExecutions)
            .set({
              state: {
                totalNodes: counts.totalNodes,
                processedNodes: 0,
                updatedNodes: 0,
                totalRelationships: counts.totalRelationships,
                processedRelationships: 0,
                updatedRelationships: 0,
                prune,
                prunedNodes: 0,
                prunedRelationships: 0,
                prunedPropertyKeys: {},
              },
            })
            .where(eq(db.agentExecutions.id, executionId)),
        ),
      ),
    );

    // ── Step: reconcile all nodes (in-step pagination, single Inngest checkpoint) ──
    const nodeResults = await step.run("reconcile-all-nodes", async () => {
      if (schemaDefinition.labelNames.length === 0) {
        return {
          processedNodes: 0,
          updatedNodes: 0,
          prunedNodes: 0,
          prunedPropertyKeys: {} as Record<string, string[]>,
        };
      }

      return runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        let skip = 0;
        let processedNodes = 0;
        let updatedNodes = 0;
        let prunedNodes = 0;
        const prunedPropertyKeys: Record<string, string[]> = {};

        for (;;) {
          const batchResult = await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND n.label IN $labels
             RETURN n.publicId AS nodeId, n.label AS label, n.properties AS properties, n.displayName AS displayName
             ORDER BY nodeId
             SKIP $skip LIMIT $batchSize`,
            {
              orgId,
              workspaceId,
              labels: schemaDefinition.labelNames,
              skip,
              batchSize: BATCH_SIZE,
            },
          );

          if (batchResult.records.length === 0) break;

          for (const record of batchResult.records) {
            const nodeId = record.get("nodeId") as string;
            const label = record.get("label") as string;
            // `n.properties` is a JSON string (canonical storage), not a map.
            const existingProps = parseNodeProps(record.get("properties"));

            const labelSchema = schemaDefinition.labelSchemaMap[label];
            if (!labelSchema) {
              processedNodes++;
              continue;
            }

            const schemaKeys = labelSchema.properties.map((p) => p.key);
            let newProps = { ...existingProps };
            let nodeUpdated = false;

            // AI-derive missing required properties that have a description.
            const missingRequired = labelSchema.properties.filter(
              (p) => p.required && p.description && !(p.key in existingProps),
            );

            if (missingRequired.length > 0) {
              try {
                const missingSchema = z.object({
                  derivedProps: z.record(z.unknown()),
                });
                const { object } = await generateObjectFor({
                  // Model and funding resolved together (ADR-053 §3, ADR-131): the key the
                  // call is built on and the party billed for it must be one answer. Asking
                  // only for `fundedBy` and letting `selectModel` fall back to the shared key
                  // is how an organisation on its own key came to be reported as having paid
                  // for a call Oxagen's key actually paid for.
                  ...(await selectModelForOrg(orgId)),
                  chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
                  schema: missingSchema,
                  prompt: `You are completing missing required schema properties for a knowledge graph node with label "${label}".
Existing properties: ${JSON.stringify(existingProps)}
Missing required properties to derive:
${missingRequired.map((p) => `  - ${p.key} (${p.dataType}): ${p.description}`).join("\n")}
Return only the derived property key-value pairs in the derivedProps field.`,
                  telemetry: {
                    orgId,
                    workspaceId,
                    surface: "runner" as const,
                    messageId: null,
                  },
                  // Bound the call so a stalled gateway can't hang the worker.
                  abortSignal: AbortSignal.timeout(AI_DERIVE_TIMEOUT_MS),
                  maxRetries: 0, // Inngest owns the retry policy for this step.
                });
                if (
                  object.derivedProps &&
                  typeof object.derivedProps === "object"
                ) {
                  newProps = { ...newProps, ...object.derivedProps };
                  nodeUpdated = true;
                }
              } catch (aiErr) {
                logger.warn(
                  { nodeId, label, err: aiErr },
                  "schema.reconcile: AI derivation failed for node — skipping AI step",
                );
              }
            }

            // Prune off-schema properties if requested.
            if (prune) {
              const { pruned, removedKeys } = buildPrunedProperties(
                newProps,
                schemaKeys,
              );
              if (removedKeys.length > 0) {
                newProps = pruned;
                nodeUpdated = true;
                prunedNodes++;
                prunedPropertyKeys[nodeId] = removedKeys;
              }
            }

            // Write back to Neo4j only if something changed.
            if (nodeUpdated) {
              await session.run(
                `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
                 SET n.properties = $properties`,
                // Serialize back to a JSON string — Neo4j rejects raw maps as
                // property values, and ingestion stores this column the same way.
                {
                  nodeId,
                  orgId,
                  workspaceId,
                  properties: JSON.stringify(newProps),
                },
              );
              updatedNodes++;
            }

            processedNodes++;
          }

          skip += BATCH_SIZE;
          if (batchResult.records.length < BATCH_SIZE) break;
        }

        return {
          processedNodes,
          updatedNodes,
          prunedNodes,
          prunedPropertyKeys,
        };
      });
    });

    // ── Step: reconcile all relationships ──────────────────────────────────────
    const relResults = await step.run(
      "reconcile-all-relationships",
      async () => {
        if (schemaDefinition.relTypeNames.length === 0) {
          return {
            processedRelationships: 0,
            updatedRelationships: 0,
            prunedRelationships: 0,
          };
        }

        return runInTenantScope({ orgId, workspaceId }, async () => {
          const session = scopedSession();
          let skip = 0;
          let processedRelationships = 0;
          let updatedRelationships = 0;
          let prunedRelationships = 0;

          for (;;) {
            const batchResult = await session.run(
              // PAGINATION, and what it is and is not safe against.
              //
              // ORDER BY gives the pages a defined boundary. Without it Cypher
              // guarantees no row order at all, so consecutive SKIP windows can
              // overlap or omit rows with nothing mutating anything. The key is
              // the endpoints' publicIds (application-generated, uniqueness-
              // constrained) then type, with the element id only as a tiebreak
              // between sibling relationships.
              //
              // The loop's OWN writes can no longer move a row out of this set:
              // `SET r += $props` touches only `r`, and reserved keys are
              // stripped from $props, so `r.is_system` — the one predicate
              // input a write could reach — is untouchable. See
              // stripReservedRelationshipKeys.
              //
              // What remains, stated rather than implied: a CONCURRENT writer
              // (ingestion, alias promotion, another reconcile, a customer's
              // own BYO endpoint) that inserts or deletes a matching
              // relationship between two pages still shifts every later offset,
              // and rows slide past unvisited with no error and no counter.
              // SKIP over a live graph is not sound against that; a keyset
              // cursor over the ordering key would be, and relationships have
              // no stable application id to key one on today. That is a
              // separate piece of work and is not closed by this change.
              `MATCH (a:GraphNode)-[r]->(b:GraphNode)
             WHERE a.orgId = $orgId AND a.workspaceId = $workspaceId
               AND ${FAR_ENDPOINT_TENANT_FILTER}
               AND ${REIDENTIFIABLE_ENDPOINTS_FILTER}
               AND type(r) IN $relTypes
               AND ${NON_SYSTEM_RELATIONSHIP_FILTER}
             RETURN elementId(r) AS relElemId, type(r) AS relType, properties(r) AS props,
                    a.publicId AS startId, b.publicId AS endId
             ORDER BY startId, endId, relType, relElemId
             SKIP $skip LIMIT $batchSize`,
              {
                orgId,
                workspaceId,
                relTypes: schemaDefinition.relTypeNames,
                skip,
                batchSize: BATCH_SIZE,
                ...PLATFORM_REL_TYPE_PARAMS,
              },
            );

            if (batchResult.records.length === 0) break;

            for (const record of batchResult.records) {
              const relElemId = record.get("relElemId") as string;
              const relType = record.get("relType") as string;
              const startId = record.get("startId") as string | null;
              const endId = record.get("endId") as string | null;
              const existingProps = (record.get("props") ?? {}) as Record<
                string,
                unknown
              >;

              const relSchema = schemaDefinition.relTypeSchemaMap[relType];
              if (!relSchema) {
                processedRelationships++;
                continue;
              }

              const schemaKeys = relSchema.properties.map((p) => p.key);
              let newProps = { ...existingProps };
              let relUpdated = false;

              // AI-derive missing required properties for relationships.
              //
              // A RESERVED key is excluded from the question rather than from
              // the answer. `schema.property.upsert` accepts any non-empty
              // name, so an organisation can pin a relationship schema whose
              // required property is `is_system`, `orgId` or any other
              // platform-owned key. Such a key is stripped at the write
              // chokepoint — correctly, it is not the schema's to set — but it
              // was still being ASKED for: the model was called, charged, and
              // its only answer discarded, the relationship left unchanged, and
              // `processedRelationships` incremented anyway. The reconcile then
              // reported success, and the next run repeated the paid call over
              // the same edges, forever, without ever being able to converge.
              //
              // Excluding it here cannot lose anything, because nothing
              // downstream would have kept it. What it does change is that the
              // impossibility is now SAID: a schema declaring a reserved
              // required property is logged by name once per batch, rather than
              // showing up only as a bill.
              const unsatisfiableRequired = relSchema.properties.filter(
                (p) =>
                  p.required &&
                  p.description &&
                  !(p.key in existingProps) &&
                  RESERVED_RELATIONSHIP_PROPERTY_KEYS.has(p.key),
              );
              if (unsatisfiableRequired.length > 0) {
                logger.warn(
                  {
                    relElemId,
                    relType,
                    keys: unsatisfiableRequired.map((p) => p.key),
                  },
                  "schema.reconcile: relationship schema requires platform-reserved properties, which reconciliation can never set; not asking the model to derive them",
                );
              }
              const missingRequired = relSchema.properties.filter(
                (p) =>
                  p.required &&
                  p.description &&
                  !(p.key in existingProps) &&
                  !RESERVED_RELATIONSHIP_PROPERTY_KEYS.has(p.key),
              );

              if (missingRequired.length > 0) {
                try {
                  const missingSchema = z.object({
                    derivedProps: z.record(z.unknown()),
                  });
                  const { object } = await generateObjectFor({
                    // Model and funding resolved together (ADR-053 §3, ADR-131): the key the
                    // call is built on and the party billed for it must be one answer. Asking
                    // only for `fundedBy` and letting `selectModel` fall back to the shared key
                    // is how an organisation on its own key came to be reported as having paid
                    // for a call Oxagen's key actually paid for.
                    ...(await selectModelForOrg(orgId)),
                    chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
                    schema: missingSchema,
                    prompt: `You are completing missing required schema properties for a knowledge graph relationship of type "${relType}".
Existing properties: ${JSON.stringify(existingProps)}
Missing required properties to derive:
${missingRequired.map((p) => `  - ${p.key} (${p.dataType}): ${p.description}`).join("\n")}
Return only the derived property key-value pairs in the derivedProps field.`,
                    telemetry: {
                      orgId,
                      workspaceId,
                      surface: "runner" as const,
                      messageId: null,
                    },
                    // Bound the call so a stalled gateway can't hang the worker.
                    abortSignal: AbortSignal.timeout(AI_DERIVE_TIMEOUT_MS),
                    maxRetries: 0, // Inngest owns the retry policy for this step.
                  });
                  if (
                    object.derivedProps &&
                    typeof object.derivedProps === "object"
                  ) {
                    // Stripped HERE as well as at the write chokepoint, so the
                    // model's attempt is visible and the counters stay honest:
                    // merging a reserved key would flip `relUpdated` for a
                    // change that is then, correctly, never written.
                    const { kept, stripped } = stripReservedRelationshipKeys(
                      object.derivedProps as Record<string, unknown>,
                    );
                    if (stripped.length > 0) {
                      logger.warn(
                        { relElemId, relType, stripped },
                        "schema.reconcile: model returned platform-reserved relationship keys; discarded",
                      );
                    }
                    if (Object.keys(kept).length > 0) {
                      newProps = { ...newProps, ...kept };
                      relUpdated = true;
                    }
                  }
                } catch (aiErr) {
                  logger.warn(
                    { relElemId, relType, err: aiErr },
                    "schema.reconcile: AI derivation failed for relationship — skipping AI step",
                  );
                }
              }

              // Prune off-schema properties from relationships if requested.
              // `properties(r)` returns EVERY property including the
              // platform-owned ones, so the reserved set is passed here or the
              // prune would target the relationship's own temporal and tenancy
              // metadata.
              let removedRelKeys: readonly string[] = [];
              // Counted only once the write CONFIRMS it landed. Incrementing
              // here would report a prune that a re-identification refusal
              // silently skipped, which is the failure this whole path is
              // being hardened against.
              let prunedThisRelationship = false;
              if (prune) {
                const { pruned, removedKeys } = buildPrunedProperties(
                  newProps,
                  schemaKeys,
                  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
                );
                if (removedKeys.length > 0) {
                  newProps = pruned;
                  removedRelKeys = removedKeys;
                  relUpdated = true;
                  prunedThisRelationship = true;
                }
              }

              // Write back to Neo4j only if something changed.
              if (relUpdated) {
                // Anchor the write to the SAME tenant the batch read anchored
                // to. An elementId is a global graph address, so an unanchored
                // `MATCH ()-[r]->()` would write any relationship in the store
                // whose id happened to collide — and it never ran at all,
                // because the scoped-session tenancy guard rejects Cypher that
                // binds no orgId. $orgId/$workspaceId are injected by the seam.
                const writeResult = await session.run(
                  RELATIONSHIP_WRITE_BACK_CYPHER,
                  {
                    relElemId,
                    relType,
                    startId,
                    endId,
                    props: buildRelationshipWriteBackProps(
                      newProps,
                      removedRelKeys,
                    ),
                    ...PLATFORM_REL_TYPE_PARAMS,
                  },
                );

                if (countOf(writeResult.records[0]?.get("written")) > 0) {
                  updatedRelationships++;
                  if (prunedThisRelationship) prunedRelationships++;
                } else {
                  // The row read at the start of this batch is not the
                  // relationship this element id names now — deleted, or its id
                  // reused. Nothing was written, so nothing is counted, and it
                  // is logged rather than swallowed: the next reconcile pass
                  // reads the graph fresh and picks it up if it still applies.
                  logger.warn(
                    { relElemId, relType, startId, endId },
                    "schema.reconcile: relationship no longer matches the row that was read; write-back skipped",
                  );
                }
              }

              processedRelationships++;
            }

            skip += BATCH_SIZE;
            if (batchResult.records.length < BATCH_SIZE) break;
          }

          return {
            processedRelationships,
            updatedRelationships,
            prunedRelationships,
          };
        });
      },
    );

    // ── Step: finalize the execution record ────────────────────────────────────
    await step.run("complete", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const finalState: ReconcileState = {
            totalNodes: counts.totalNodes,
            processedNodes: nodeResults.processedNodes,
            updatedNodes: nodeResults.updatedNodes,
            totalRelationships: counts.totalRelationships,
            processedRelationships: relResults.processedRelationships,
            updatedRelationships: relResults.updatedRelationships,
            prune,
            prunedNodes: nodeResults.prunedNodes,
            prunedRelationships: relResults.prunedRelationships,
            prunedPropertyKeys: nodeResults.prunedPropertyKeys,
          };

          const completedAt = new Date();

          // Look up startedAt to compute latencyMs.
          const execRow = await tx.query.agentExecutions.findFirst({
            where: eq(db.agentExecutions.id, executionId),
            columns: { startedAt: true },
          });

          const latencyMs = execRow?.startedAt
            ? completedAt.getTime() - execRow.startedAt.getTime()
            : null;

          await tx
            .update(db.agentExecutions)
            .set({
              status: "completed",
              completedAt,
              latencyMs,
              outputPayload: finalState,
              state: finalState,
            })
            .where(eq(db.agentExecutions.id, executionId));
        }),
      ),
    );

    logger.info(
      {
        executionId,
        orgId,
        workspaceId,
        versionId,
        prune,
        totalNodes: counts.totalNodes,
        updatedNodes: nodeResults.updatedNodes,
        prunedNodes: nodeResults.prunedNodes,
        totalRelationships: counts.totalRelationships,
        updatedRelationships: relResults.updatedRelationships,
        prunedRelationships: relResults.prunedRelationships,
      },
      "schema.reconcile: completed",
    );

    return {
      executionId,
      status: "completed",
      totalNodes: counts.totalNodes,
      processedNodes: nodeResults.processedNodes,
      updatedNodes: nodeResults.updatedNodes,
      totalRelationships: counts.totalRelationships,
      processedRelationships: relResults.processedRelationships,
      updatedRelationships: relResults.updatedRelationships,
      prunedNodes: nodeResults.prunedNodes,
      prunedRelationships: relResults.prunedRelationships,
    };
  },
);
