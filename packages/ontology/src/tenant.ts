import {
  assertDataPlaneUsable,
  requireScope,
  resolveDataPlane,
  TenantScopeError,
  type Neo4jPlaneConfig,
} from "@oxagen/tenancy";
import type { Session } from "neo4j-driver";
import { neo4jBreaker } from "@oxagen/telemetry";
import { session } from "./client";
import { dedicatedSession } from "./data-plane-driver";
import {
  applyGraphScope,
  GraphScopeError,
  keepFilteringPositions,
  rowSelectingParts,
} from "./graph-scope";
import type { GraphScope } from "./graph-scope";

export { GraphScopeError };
export type { GraphScope };

// A scoped query must bind the tenant to THE SEAM'S OWN PARAMETER. Four
// conditions; the fourth is the one the first three spent three review rounds
// not having.
//
// 1) SANITIZED text. `stripLiteralsAndComments` blanks comments, string
//    literals and backtick identifiers, so `orgId` named only in a comment or a
//    quoted value cannot satisfy the guard.
// 2) FILTERING position. `keepFilteringPositions` blanks everything that is not
//    a `WHERE` clause or an inline pattern property map, so a `SET` target
//    (`MATCH (n) SET n.orgId = $orgId`, which reassigns every tenant's nodes to
//    the caller) and a `RETURN`/`WITH` projection do not count. The map must
//    also sit in a clause that SELECTS rows: `CREATE`'s map stamps a node being
//    made, and `MERGE`'s constrains only what it merges, so a `MERGE` map
//    counts only when no earlier clause has bound a graph variable — the case
//    where there is nothing else for it to have failed to narrow.
// 3) A binding SHAPE: `orgId` against `:` or `=`.
// 4) THE SEAM'S PARAMETER on the other side of it. Conditions 1–3 check the
//    GRAMMAR of a tenancy anchor and never check what it binds to, which is a
//    hole wide enough to drive a whole tenant through:
//
//        MATCH (n) WHERE n.orgId = $victimOrgId RETURN n
//
//    sits in a WHERE, in a filtering position, comparing the tenant column to a
//    parameter — it satisfies every earlier refinement — and the caller chooses
//    `$victimOrgId`, so it reads another organisation's rows while the injected
//    `$orgId` goes unused. Only `$orgId` is seam-owned: run() overwrites it on
//    every call (`{ ...params, orgId, workspaceId }`), so a caller cannot
//    influence it. Any other parameter name is caller-controlled by definition.
//
// `orgId IN $orgIds` is deliberately NOT accepted. The seam injects no list, so
// that form can only ever compare against a caller-supplied value; an earlier
// version of this guard accepted it, and this file carried a test asserting
// that acceptance — a test that asserted a cross-tenant read was fine.
//
// The reversed comparison (`$orgId = n.orgId`) is not accepted either: no query
// in the tree writes it, and every accepted shape is another way through.
//
// THIS GUARD IS A LINT, NOT AN ENFORCEMENT MECHANISM. It cannot be sound, and
// the reason is worth stating where the code is rather than in a review thread.
//
// It answers a syntactic question — does a seam-bound tenant filter appear in a
// position that can narrow rows — and the property we actually want is semantic:
// is every row this query touches inside the caller's organisation. The two come
// apart, and not at the margins:
//
//     MATCH (a:GraphNode {orgId: $orgId}) MATCH (b:GraphNode) RETURN b
//
// has a real anchor, seam-bound, in a filtering position, in a row-selecting
// clause. It satisfies every condition above and returns every tenant's nodes.
// A full Cypher parse does not close this: a parser reports structure, and this
// structure is correct. What is wrong is reachability.
//
// So the guard catches the common authoring mistake — a query written with no
// tenant filter at all, or with one that does not bind — and it is defence in
// depth. `tenant.scope-guard.test.ts` carries a describe block asserting the
// cross-tenant queries it is KNOWN to accept, so the gap stays visible. The
// durable answer is to construct the scoping rather than validate it; see
// docs/adr/ADR-087.
//
// BOTH ENDS OF THE PATTERN ARE DELIMITED BY CYPHER'S RULES, NOT JAVASCRIPT'S.
// Condition 4 only holds if `$orgId` really is where the parameter name ENDS,
// and `orgId` really is where the property name BEGINS. `\b` can decide
// neither: it is ASCII-only, while a Cypher unescaped symbolic name is Unicode
// (openCypher: `IdentifierPart = ID_Continue | Sc`). `\b` fires between `d` and
// `é`, so all three of these satisfied the old pattern:
//
//     WHERE n.orgId  = $orgIdé    the seam's own $orgId goes UNUSED; the caller
//                                 supplies `orgIdé` = another tenant's id
//     WHERE n.éorgId = $orgId     filters a property that is not the tenant
//                                 column, against a parameter that is
//     WHERE $orgId   = $orgId     a tautology, with no property in it at all
//
// The first is the one review found. The other two are the same defect read
// from the other end of the pattern, and a `\b`-shaped fix for one leaves the
// others standing. `\p{Sc}` belongs in the class on purpose: `$` is a currency
// symbol, it continues an identifier in Cypher, and excluding it in the
// LOOKBEHIND is exactly what stops the third case — the parameter `$orgId`
// being matched as though it were a bare property name.
//
// AND `orgId` HAS TO BE A PROPERTY, NOT A NAME THAT READS LIKE ONE. Conditions
// 1-4 check where the token sits and what it binds to, and never checked that
// the left-hand side is a property ACCESS at all. A query may bind a variable
// called `orgId`, and then the anchor is a tautology:
//
//     WITH $orgId AS orgId MATCH (n) WHERE orgId = $orgId RETURN n
//     UNWIND [$orgId] AS orgId MATCH (n) WHERE orgId = $orgId RETURN n
//
// Both compare the injected parameter with itself, are true for every row, and
// scope nothing. Cypher spells the two things that ARE anchors differently from
// a bare name, so the guard now spells them differently too:
//
//   PROPERTY  `<variable>.orgId = $orgId`  — a dot, and an identifier before it
//   MAP KEY   `orgId: $orgId`              — a key inside a pattern property map
//
// The identifier before the dot must not be a PARAMETER. `$` is a currency
// symbol and therefore in the identifier-part class, so the same lookbehind that
// refused `$orgId = $orgId` also refuses `$p.orgId = $orgId` — where the caller
// supplies `$p = {orgId: <their own org>}` and gets another tautology.
//
// WHAT THIS STILL ACCEPTS, and it is Claim B rather than a missed spelling:
//
//     WITH {orgId: $orgId} AS m MATCH (n) WHERE m.orgId = $orgId RETURN n
//
// is a qualified property access on a variable bound to a map, so it is a
// tautology wearing an anchor's exact syntax. Telling it from `n.orgId` needs to
// know what `m` is BOUND to, which is dataflow and not spelling; no lexical rule
// reaches it. `tenant.scope-guard.test.ts` asserts it as known-accepted.
const ID_START = "\\p{ID_Start}\\p{Pc}";
const ID_PART = "\\p{ID_Continue}\\p{Sc}";
/** `<variable>.orgId = $orgId` — a dot, and a non-parameter identifier before it. */
const ANCHOR_PROPERTY = `(?<![${ID_PART}])[${ID_START}][${ID_PART}]*\\s*\\.\\s*orgId\\s*=\\s*\\$orgId(?![${ID_PART}])`;
/** `orgId: $orgId` — a pattern property map key. Never preceded by a dot. */
const ANCHOR_MAP_KEY = `(?<![${ID_PART}.])orgId\\s*:\\s*\\$orgId(?![${ID_PART}])`;
const SCOPE_GUARD = new RegExp(`${ANCHOR_PROPERTY}|${ANCHOR_MAP_KEY}`, "u");
/** `ANCHOR_PROPERTY` with the anchored variable captured, for the per-part rule. */
const ANCHORED_VARIABLE = new RegExp(
  `(?<![${ID_PART}])([${ID_START}][${ID_PART}]*)\\s*\\.\\s*orgId\\s*=\\s*\\$orgId(?![${ID_PART}])`,
  "gu",
);
/** A pattern variable: the name written first inside a node `(` or relationship `[`. */
const PATTERN_VARIABLE = new RegExp(
  `[([]\\s*([${ID_START}][${ID_PART}]*)`,
  "gu",
);

// EVERY ROW-SELECTING PATTERN PART IS ANCHORED (M0, spec §5.3).
//
// The query-wide check above answers "is the tenant bound somewhere", and the
// query ADR-087 leads with shows why that is not enough:
//
//     MATCH (a:GraphNode {orgId: $orgId}) MATCH (b:GraphNode) RETURN b
//
// Against the pooled database it returns every tenant's nodes; the real-Neo4j
// probe (`integration/tenant-isolation.test.ts`) runs the raw form to prove it.
// So the seam also asks the question per PART: every comma-separated pattern
// part of every `MATCH` / `OPTIONAL MATCH` clause, at every subquery level,
// must be anchored in one of three ways:
//
//   - its own pattern property map binds the tenant (`(b {orgId: $orgId})`);
//   - its clause's WHERE binds the tenant on a variable written in the part
//     (`MATCH (b) WHERE b.orgId = $orgId`); or
//   - it names a variable an EARLIER anchored part bound
//     (`MATCH (c {orgId: $orgId}) OPTIONAL MATCH (e)-[:CITED]->(c)`).
//
// Every variable of an anchored part counts as anchored for the parts after
// it, in the same top-level UNION branch. That closes the second unanchored
// MATCH, the unanchored OPTIONAL MATCH, the unanchored UNION branch, the MATCH
// after an anchoring MERGE, and the Cartesian product
// (`MATCH (a {orgId: $orgId}), (b)`), which is the same defect spelled with a
// comma.
//
// It is still a syntactic rule and still not Claim B. What it accepts, and
// `tenant.scope-guard.test.ts` records: a part is credited as a whole, so a
// traversal leaving an anchored node (`(a {orgId: $orgId})-[*1..3]-(b)`)
// reaches whatever the edges reach. That crosses tenants only over a
// cross-tenant edge, and writing one through this seam needs a MATCH on the
// other tenant's node, which this rule now refuses. A variable re-bound by
// `WITH … AS` keeps no credit (fail-closed), and a WHERE anchor inside an `OR`
// is credited (the query-wide limitation, unchanged). #3199 remains the fix
// that closes the class.
function assertEveryPartAnchored(cypher: string): void {
  let branch = -1;
  let anchored = new Set<string>();
  for (const part of rowSelectingParts(cypher)) {
    if (part.branch !== branch) {
      branch = part.branch;
      anchored = new Set();
    }
    const variables = [...part.pattern.matchAll(PATTERN_VARIABLE)].map(
      (m) => m[1]!,
    );
    const whereAnchored = new Set(
      [...part.where.matchAll(ANCHORED_VARIABLE)].map((m) => m[1]!),
    );
    const isAnchored =
      SCOPE_GUARD.test(part.anchors) ||
      variables.some((v) => whereAnchored.has(v) || anchored.has(v));
    if (!isAnchored) {
      throw new TenantScopeError(
        `Every MATCH pattern in a scoped query must bind the tenant — in its own pattern map (\`(b {orgId: $orgId})\`), in its clause's WHERE on one of its own variables (\`WHERE b.orgId = $orgId\`), or through a variable an earlier anchored pattern bound. An anchor on some other pattern does not scope this one: ${part.pattern.trim().slice(0, 80)}`,
      );
    }
    for (const v of variables) anchored.add(v);
  }
}

/**
 * Throw unless `cypher` binds the tenant to the seam's own `$orgId` in a
 * FILTERING position, and every row-selecting pattern part binds it itself.
 *
 * Exported for the seam's own tests, which need to drive the assertion with a
 * string the clamps cannot currently produce — see the re-check in `run()`
 * below, which is an enforced invariant rather than a reachable failure today.
 */
export function assertAnchorsTenant(cypher: string): void {
  if (!SCOPE_GUARD.test(keepFilteringPositions(cypher))) {
    throw new TenantScopeError(
      `Cypher over a scoped session must bind the tenant to the seam's own $orgId, in a WHERE predicate (\`WHERE n.orgId = $orgId\`) or an inline pattern property (\`MATCH (n {orgId: $orgId})\`). A SET target, a RETURN projection, and any other parameter name (which the caller controls) do not scope anything: ${cypher.slice(0, 80)}`,
    );
  }
  assertEveryPartAnchored(cypher);
}

/**
 * Return a Neo4j session bound to the active tenant scope. Throws
 * TenantScopeError immediately if there is no active tenant scope (checked at
 * scopedSession() call time, not lazily inside run()). The returned session's
 * run():
 *  1. Rejects Cypher that does not bind `orgId` TO THE INJECTED `$orgId` in a
 *     FILTERING position — `WHERE n.orgId = $orgId` or
 *     `MATCH (n {orgId: $orgId})`. A SET target, a RETURN projection, and any
 *     other parameter name all fail (seam-bypass guard).
 *  2. Injects `$orgId` and `$workspaceId` into every params object so the
 *     Cypher never has to thread them manually.
 *
 * Agent RBAC Phase 3 (spec §3.6): pass an optional `GraphScope` to bind the
 * session to an agent principal's graph-access ceiling. When a scope is given,
 * run() additionally, ON TOP of the tenancy guarantees above:
 *  3. Requires the query to FILTER on the reserved scope markers
 *     (`… IN $__scopeLabels` / `… IN $__scopeRelTypes`) for each constrained
 *     dimension — same bypass-guard style as tenancy, but a STRICTER position
 *     rule: a membership test earns its standing from the boolean it produces,
 *     so it counts only in a WHERE clause, never as a pattern-property value
 *     (`MERGE (n {allowed: l IN $__scopeLabels})` stores the answer and refuses
 *     nothing) — and injects those allow-lists as parameters the query builder
 *     consumes in its WHERE clauses.
 *  4. Clamps the traversal budget server-side: literal `LIMIT`s down to
 *     `maxNodes` (adds one when absent), variable-length hop bounds to
 *     `maxHops`, and a per-query transaction timeout for `maxTraversalMs`.
 *  5. Rejects write clauses when `mode` is `read` (defense in depth).
 *
 * Omitting the scope (the default) leaves behavior byte-identical to before:
 * humans and scope-less sessions are pass-through. Existing callers that call
 * `scopedSession()` with no argument are unaffected.
 */
export function scopedSession(scope?: GraphScope): {
  run: (
    cypher: string,
    params?: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<ReturnType<typeof session>["run"]>>>;
  close: () => Promise<void>;
} {
  const { orgId, workspaceId } = requireScope();

  // ADR-042: which physical Neo4j this organisation's graph lives on is
  // resolved LAZILY, on the first run(). Two reasons the resolution cannot
  // happen here: scopedSession() is synchronous (every caller depends on that,
  // and the no-scope guard above must stay a synchronous throw), and the
  // resolver is async because it reads org.data_planes. Deferring also means a
  // session that is created and never used opens no connection at all.
  let s: Session | null = null;
  async function ensureSession(): Promise<Session> {
    if (s) return s;
    const plane = await resolveDataPlane(orgId, "neo4j");
    // Fail closed: a degraded or disabled graph plane throws rather than
    // quietly answering from the platform's own graph, which would leak one
    // tenant's ontology into a store the customer moved its data out of.
    assertDataPlaneUsable(plane);
    // A shared plane is either the POOLED database (no `database` on the
    // binding) or the organisation's own database on the platform cluster,
    // created by an OrgGraphProvisioner at organisation creation (ADR-098).
    s =
      plane.mode === "shared"
        ? session(plane.database)
        : dedicatedSession({
            orgId,
            config: plane.config as Neo4jPlaneConfig,
            configDigest: plane.configDigest,
          });
    return s;
  }

  return {
    async run(cypher: string, params: Record<string, unknown> = {}) {
      // Reduce to filtering positions before testing, so a mention of `orgId`
      // in a comment, a string literal, a SET target or a RETURN projection
      // cannot satisfy the tenancy guard. The error quotes the ORIGINAL text,
      // which is what the author wrote and has to fix.
      assertAnchorsTenant(cypher);
      const sess = await ensureSession();

      // No agent scope → behaviorally unchanged pass-through (humans and
      // scope-less sessions). Guard the shared Neo4j driver with the circuit
      // breaker: a degraded AuraDB fails fast (CircuitOpenError) instead of
      // every scoped query piling handshake attempts onto a down cluster. The
      // TenantScopeError guard above is deliberately OUTSIDE the breaker — a
      // programming error must never count toward tripping it.
      if (scope === undefined) {
        return neo4jBreaker().exec(() =>
          sess.run(cypher, { ...params, orgId, workspaceId }),
        );
      }

      // Agent-scoped session: enforce the GraphScope ceiling server-side. The
      // GraphScopeError thrown by applyGraphScope (bypass guard, write
      // rejection, unenforceable budget shape) is, like TenantScopeError,
      // OUTSIDE the breaker — a policy violation must not trip it.
      const applied = applyGraphScope(cypher, params, scope);
      // THE STRING THAT EXECUTES IS THE STRING THAT WAS CHECKED.
      //
      // `applyGraphScope` REWRITES the query — `clampVarLengthHops` rebounds a
      // `*1..5` quantifier, `clampLimits` clamps a literal `LIMIT` or appends
      // one — and `sess.run` below is handed the rewritten form. The tenancy
      // guard at the top of `run()` read the AUTHORED text, so the seam
      // validated one string and executed another: a decision about an artifact
      // that is not the artifact the decision governs, which is the shape of
      // every defect this seam has been corrected for.
      //
      // No clamp can break an anchor today, and the reason is bounded rather
      // than hopeful — their whole output alphabet is digits, `*` and `..`
      // substituted strictly between an existing `[` and `]`, plus a trailing
      // "\nLIMIT <digits>", none of which can delete an anchor or introduce a
      // bracket, brace, clause or write keyword. But that is a property of the
      // clamp BODIES, which whoever edits them next would have to re-derive.
      //
      // It is asserted UNCONDITIONALLY rather than only when the text changed.
      // An identity gate would be cheaper and behaves identically, which is the
      // problem with it: no test can tell it from its absence, and an
      // unfalsifiable line in this seam is how several of these rounds started.
      // The cost is one lexer pass on the agent-scoped path only.
      //
      // The first guard stays where it is. It reads what the author wrote and
      // quotes it in the error, which is the text they have to fix;
      // `tenant.executed-cypher.test.ts` pins that the two are different checks.
      assertAnchorsTenant(applied.cypher);
      const finalParams = { ...applied.params, orgId, workspaceId };
      return neo4jBreaker().exec(() =>
        applied.txConfig
          ? sess.run(applied.cypher, finalParams, applied.txConfig)
          : sess.run(applied.cypher, finalParams),
      );
    },
    // A session that never ran opened no connection, so there is nothing to
    // close — resolve rather than force every caller to branch.
    close: async () => {
      if (s) await s.close();
    },
  };
}
