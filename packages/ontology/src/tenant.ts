import { requireScope, TenantScopeError } from "@oxagen/tenancy";
import { neo4jBreaker } from "@oxagen/telemetry";
import { session } from "./client";

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
 */
export function scopedSession(): {
  run: (cypher: string, params?: Record<string, unknown>) => Promise<Awaited<ReturnType<ReturnType<typeof session>["run"]>>>;
  close: () => Promise<void>;
} {
  const { orgId, workspaceId } = requireScope();
  const s = session();
  return {
    async run(cypher: string, params: Record<string, unknown> = {}) {
      if (!SCOPE_GUARD.test(cypher)) {
        throw new TenantScopeError(
          `Cypher over a scoped session must filter by $orgId: ${cypher.slice(0, 80)}`,
        );
      }
      // Guard the shared Neo4j driver with the circuit breaker: a degraded
      // AuraDB fails fast (CircuitOpenError) instead of every scoped query in
      // the platform piling handshake attempts onto a down cluster. The
      // TenantScopeError guard above is deliberately OUTSIDE the breaker — a
      // programming error must never count toward tripping it.
      return neo4jBreaker().exec(() => s.run(cypher, { ...params, orgId, workspaceId }));
    },
    close: () => s.close(),
  };
}
