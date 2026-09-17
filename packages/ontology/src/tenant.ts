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
//    the caller) and a `RETURN`/`WITH` projection do not count.
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
// What this still does NOT promise: isolation. A query can anchor one MATCH
// with $orgId and leave a second MATCH unanchored. The seam establishes that
// the tenant filter exists, is positioned to filter, and is bound to the
// caller's own organisation — which is what a lexical check can enforce across
// every query in the platform.
const SCOPE_GUARD = /\borgId\s*[:=]\s*\$orgId\b/;

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
 *     dimension — same bypass-guard style as tenancy, same sanitize-then-
 *     require-a-filtering-position rule — and injects those allow-lists as
 *     parameters the query builder consumes in its WHERE clauses.
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
    s =
      plane.mode === "shared"
        ? session()
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
      if (!SCOPE_GUARD.test(keepFilteringPositions(cypher))) {
        throw new TenantScopeError(
          `Cypher over a scoped session must bind the tenant to the seam's own $orgId, in a WHERE predicate (\`WHERE n.orgId = $orgId\`) or an inline pattern property (\`MATCH (n {orgId: $orgId})\`). A SET target, a RETURN projection, and any other parameter name (which the caller controls) do not scope anything: ${cypher.slice(0, 80)}`,
        );
      }
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
