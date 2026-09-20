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
  expressionLocalBindings,
  GraphScopeError,
  keepFilteringPositions,
  keepPredicatePositions,
  projectedNames,
  rowSelectingScope,
  stripLiteralsAndComments,
} from "./graph-scope";
import type { GraphScope, RowSelectingPart, ScopeEvent } from "./graph-scope";

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
/** `orgId: $orgId` — a pattern property map key. Never preceded by a dot. */
const ANCHOR_MAP_KEY = `(?<![${ID_PART}.])orgId\\s*:\\s*\\$orgId(?![${ID_PART}])`;
/**
 * The map-key form, tested against PATTERN-MAP positions only. Each of the two
 * anchor shapes belongs to exactly one position, and reading either in the
 * other's is a hole: inside a pattern map a `x.orgId = $orgId` can only be a
 * map VALUE — `MATCH (a {orgId: $orgId}) MATCH (n {ok: a.orgId = $orgId})`
 * constrains `n.ok`, not `n.orgId`, and every tenant's `n` with `ok: true`
 * comes back — while a map key cannot occur in a WHERE at all, since every
 * map literal there is blanked.
 */
const MAP_KEY_ANCHOR = new RegExp(ANCHOR_MAP_KEY, "u");
/**
 * `<variable>.orgId = $orgId` — a dot, and a non-parameter identifier before
 * it, captured — tested against WHERE positions only.
 */
const ANCHORED_VARIABLE = new RegExp(
  `(?<![${ID_PART}])([${ID_START}][${ID_PART}]*)\\s*\\.\\s*orgId\\s*=\\s*\\$orgId(?![${ID_PART}])`,
  "gu",
);

/**
 * The variables a WHERE projection anchors — `<v>.orgId = $orgId` — minus
 * every anchor whose variable is an EXPRESSION-LOCAL name at that position.
 *
 *     MATCH (n) WHERE any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n
 *
 * spells the anchor exactly, and the `n` it names is the list predicate's,
 * bound to the map and compared with its own value: true for every row, so
 * the pattern's `n` reads every tenant. A name a list predicate, a list
 * comprehension or a `reduce` binds shadows the pattern variable inside its
 * bracket, and an anchor inside that bracket is credit for the local, not for
 * the pattern. `expressionLocalBindings` reports the brackets and the names.
 */
function whereAnchoredVariables(where: string): Set<string> {
  const regions = expressionLocalBindings(where);
  const anchored = new Set<string>();
  for (const m of where.matchAll(ANCHORED_VARIABLE)) {
    const name = m[1]!;
    const at = m.index;
    const shadowed = regions.some(
      (r) => r.start < at && at < r.end && r.names.includes(name),
    );
    if (!shadowed) anchored.add(name);
  }
  return anchored;
}
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
//   - one of its PATTERN ELEMENTS names a variable an earlier anchored part
//     bound, and that variable is STILL IN SCOPE
//     (`MATCH (c {orgId: $orgId}) OPTIONAL MATCH (e)-[:CITED]->(c)`).
//
// The third way is where the two review findings this block answers both sat,
// and they are the same mistake read from either end: crediting a NAME rather
// than a VARIABLE.
//
// WHICH NAMES A PART BINDS. A pattern element's variable is the identifier
// written first inside its `(` or `[`, and `RowSelectingPart.variables` lists
// exactly those, from the brackets the scanner classified as pattern elements.
// A regex over every `(` and `[` in the part's text credited
// `MATCH (b {x: toString(a.x)})` with `a`, because `toString(` is a paren —
// but `b` is joined to `a` by nothing, and in the pooled database another
// tenant's `b` with the same `x` matches. A name in a property value, a label
// expression or an inline predicate is a reference to a value, not an element
// of the pattern, so it earns the part nothing.
//
// WHICH VARIABLES ARE STILL IN SCOPE. Cypher's variable scope is not
// "everything bound so far", and `anchored` used to be exactly that, reset
// only at a top-level `UNION`. So
//
//     MATCH (n {orgId: $orgId}) WITH count(n) AS c MATCH (n) RETURN n
//
// passed: the second `n` is a fresh variable — `WITH` discarded the first —
// and it reads every tenant's rows, but the set still held the name. The walk
// below follows the scope events `rowSelectingScope` interleaves with the
// parts, and each event does to the credited set what Cypher does to the
// scope:
//
//   - `with` / `return` REPLACE the set with what the projection keeps: `*`
//     keeps all, a bare variable keeps itself, and an expression or an
//     `AS` alias keeps nothing (`WITH n AS m` is fail-closed, as before).
//   - `open` starts a scope of its own. A `CALL { … }` body sees only what it
//     imports — a scope clause `CALL (n) { … }`, or an importing `WITH` as
//     its first clause, read from the enclosing set; an expression subquery
//     (`EXISTS` / `COUNT` / `COLLECT`) sees the enclosing set whole.
//   - `close` discards the body's set. A `CALL` hands back what its `RETURN`
//     projected — every branch's, intersected, if it had a `UNION` — and an
//     expression subquery hands back nothing.
//   - `union` at ANY level restarts the current scope from what it was handed
//     at entry, so nothing one branch bound is visible in the next.
//
// That closes the second unanchored MATCH, the unanchored OPTIONAL MATCH, the
// unanchored UNION branch at any level, the MATCH after an anchoring MERGE,
// the Cartesian product (`MATCH (a {orgId: $orgId}), (b)`), the re-bound name
// after a `WITH`, the expression-only join, and the CALL body that never
// imported the anchored variable.
//
// It is still a syntactic rule and still not Claim B. What it accepts, and
// `tenant.scope-guard.test.ts` records: a part is credited as a whole, so a
// traversal leaving an anchored node (`(a {orgId: $orgId})-[*1..3]-(b)`)
// reaches whatever the edges reach. That crosses tenants only over a
// cross-tenant edge, and writing one through this seam needs a MATCH on the
// other tenant's node, which this rule refuses. A WHERE anchor inside an `OR`
// is credited (the query-wide limitation, unchanged). #3199 remains the fix
// that closes the class.

/** One variable scope the walk is inside: the query, or a subquery body. */
interface AnchorScope {
  /** Anchored variables visible here, as of the current clause. */
  anchored: Set<string>;
  /** What the scope started with; a `UNION` branch restarts from it. */
  readonly entry: ReadonlySet<string>;
  /** The enclosing scope's set at `open`, for an importing `WITH` to read. */
  readonly outer: ReadonlySet<string>;
  /** `"call"` exports its `RETURN`; `"expression"` and the query export nothing. */
  readonly kind: "query" | "call" | "expression";
  /**
   * A `CALL { … }` with no scope clause imports through a `WITH` written as
   * its FIRST clause, and that `WITH` projects from the enclosing set rather
   * than from the body's (empty) one. `importsByWith` says the body is that
   * form; `awaitingImport` is true until its first event, and again after a
   * `UNION`, since each branch imports for itself.
   */
  readonly importsByWith: boolean;
  awaitingImport: boolean;
  /** For `"call"`: what every branch's `RETURN` kept, or null before the first. */
  exported: Set<string> | null;
}

function isPartAnchored(
  part: RowSelectingPart,
  anchored: ReadonlySet<string>,
): boolean {
  if (MAP_KEY_ANCHOR.test(part.anchors)) return true;
  const whereAnchored = whereAnchoredVariables(part.where);
  return part.variables.some((v) => whereAnchored.has(v) || anchored.has(v));
}

function assertEveryPartAnchored(cypher: string): void {
  const root: AnchorScope = {
    anchored: new Set(),
    entry: new Set(),
    outer: new Set(),
    kind: "query",
    importsByWith: false,
    awaitingImport: false,
    exported: null,
  };
  const stack: AnchorScope[] = [root];
  const scope = () => stack[stack.length - 1]!;
  const events: ScopeEvent[] = rowSelectingScope(cypher);
  for (const event of events) {
    const here = scope();
    switch (event.kind) {
      case "part": {
        here.awaitingImport = false;
        if (!isPartAnchored(event.part, here.anchored)) {
          throw new TenantScopeError(
            `Every MATCH pattern in a scoped query must bind the tenant — in its own pattern map (\`(b {orgId: $orgId})\`), in its clause's WHERE on one of its own variables (\`WHERE b.orgId = $orgId\`), or through a variable an earlier anchored pattern bound that is still in scope. An anchor on some other pattern, a variable a WITH has dropped, and a variable named only inside a property value do not scope this one: ${event.part.pattern.trim().slice(0, 80)}`,
          );
        }
        for (const v of event.part.variables) here.anchored.add(v);
        break;
      }
      case "with": {
        const source = here.awaitingImport ? here.outer : here.anchored;
        here.awaitingImport = false;
        here.anchored = projectedNames(event.projection, source);
        break;
      }
      case "return": {
        here.awaitingImport = false;
        here.anchored = projectedNames(event.projection, here.anchored);
        if (here.kind === "call") {
          // Every UNION branch of a CALL body returns the same columns; a
          // column is credited only if EVERY branch's `RETURN` kept it
          // anchored, since the rows of any one branch reach the caller.
          here.exported =
            here.exported === null
              ? new Set(here.anchored)
              : new Set([...here.exported].filter((v) => here.anchored.has(v)));
        }
        break;
      }
      case "open": {
        here.awaitingImport = false;
        const outer = here.anchored;
        let entry: Set<string>;
        if (event.subquery === "expression") {
          entry = new Set(outer);
        } else if (event.imports === "all") {
          entry = new Set(outer);
        } else if (event.imports === null) {
          entry = new Set();
        } else {
          entry = new Set(event.imports.filter((v) => outer.has(v)));
        }
        const importsByWith =
          event.subquery === "call" && event.imports === null;
        stack.push({
          anchored: new Set(entry),
          entry,
          outer,
          kind: event.subquery,
          importsByWith,
          awaitingImport: importsByWith,
          exported: null,
        });
        break;
      }
      case "close": {
        // The root is never popped: a stray `}` has no scope to close, and the
        // query-wide check refuses an unbalanced query before this runs.
        if (stack.length === 1) break;
        const closed = stack.pop()!;
        if (closed.kind === "call" && closed.exported !== null) {
          for (const v of closed.exported) scope().anchored.add(v);
        }
        break;
      }
      case "union": {
        here.anchored = new Set(here.entry);
        here.awaitingImport = here.importsByWith;
        break;
      }
    }
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
  // Each shape in its own position: the map-key form where a pattern map is
  // kept, the property form where a WHERE is — and the latter credited only
  // to a variable no expression inside that WHERE re-binds.
  if (
    !MAP_KEY_ANCHOR.test(keepFilteringPositions(cypher)) &&
    whereAnchoredVariables(keepPredicatePositions(cypher)).size === 0
  ) {
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
 * Omitting the optional scope leaves the query unchanged after tenant checks.
 * Read queries use managed retries. Writes execute once without replay.
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

  function runQuery(
    sess: Session,
    cypher: string,
    params: Record<string, unknown>,
    config?: Parameters<Session["executeRead"]>[1],
  ) {
    // Writes and unknown procedures must not retry: an acknowledgement can
    // be lost after a committed mutation with no caller-stable idempotency key.
    const text = stripLiteralsAndComments(cypher);
    const writes = /\b(?:CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL)\b/i.test(
      text,
    );
    if (writes) {
      return config
        ? sess.run(cypher, params, config)
        : sess.run(cypher, params);
    }
    return sess.executeRead(async (tx) => await tx.run(cypher, params), config);
  }

  return {
    async run(cypher: string, params: Record<string, unknown> = {}) {
      // Reduce to filtering positions before testing, so a mention of `orgId`
      // in a comment, a string literal, a SET target or a RETURN projection
      // cannot satisfy the tenancy guard. The error quotes the ORIGINAL text,
      // which is what the author wrote and has to fix.
      assertAnchorsTenant(cypher);
      const sess = await ensureSession();

      // Without an agent scope, execute the authored query with read-only
      // retries. Guard the shared Neo4j driver with the circuit
      // breaker: a degraded AuraDB fails fast (CircuitOpenError) instead of
      // every scoped query piling handshake attempts onto a down cluster. The
      // TenantScopeError guard above is deliberately OUTSIDE the breaker — a
      // programming error must never count toward tripping it.
      if (scope === undefined) {
        return neo4jBreaker().exec(() =>
          runQuery(sess, cypher, { ...params, orgId, workspaceId }),
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
        runQuery(sess, applied.cypher, finalParams, applied.txConfig),
      );
    },
    // A session that never ran opened no connection, so there is nothing to
    // close — resolve rather than force every caller to branch.
    close: async () => {
      if (s) await s.close();
    },
  };
}
