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
import { applyGraphScope, GraphScopeError } from "./graph-scope";
import type { GraphScope } from "./graph-scope";

export { GraphScopeError };
export type { GraphScope };

// A scoped query must reference the tenant on a node (read) or in a MERGE key.
// The guard checks that `orgId` appears somewhere in the Cypher string so that
// every query filters or writes the tenant dimension.
const SCOPE_GUARD = /\borgId\b/;

/**
 * Return a Neo4j session bound to the active tenant scope. Throws
 * TenantScopeError immediately if there is no active tenant scope (checked at
 * scopedSession() call time, not lazily inside run()). The returned session's
 * run():
 *  1. Rejects Cypher that doesn't reference `orgId` (seam-bypass guard).
 *  2. Injects `$orgId` and `$workspaceId` into every params object so the
 *     Cypher never has to thread them manually.
 *
 * Agent RBAC Phase 3 (spec §3.6): pass an optional `GraphScope` to bind the
 * session to an agent principal's graph-access ceiling. When a scope is given,
 * run() additionally, ON TOP of the tenancy guarantees above:
 *  3. Requires the query to reference the reserved scope markers
 *     (`$__scopeLabels`/`$__scopeRelTypes`) for each constrained dimension —
 *     same bypass-guard style as tenancy — and injects those allow-lists as
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
      if (!SCOPE_GUARD.test(cypher)) {
        throw new TenantScopeError(
          `Cypher over a scoped session must filter by $orgId: ${cypher.slice(0, 80)}`,
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
