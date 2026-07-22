// Shared dispatch-lineage outcome derivation (issue #1078).
//
// Lives in @oxagen/agent (not @oxagen/handlers) because BOTH the fleet-lineage
// graph projection (./lineage-projection.ts, called from packages/agent's own
// agent.subagent.cancel handler) and the query_lineage handler
// (packages/handlers/src/lineage.query.ts) need it, and @oxagen/handlers
// already depends on @oxagen/agent — the reverse import would be circular.
// packages/handlers/src/lineage.query.ts re-exports these from here rather
// than defining its own copy.

/** The exact error_reason the cancel handler writes (agent.subagent.cancel.ts)
 * — the only way a subagent_runs row distinguishes a genuine failure from a
 * cancellation, since the status column's CHECK constraint has no 'cancelled'
 * value. */
export const CANCEL_ERROR_REASON = "Cancelled by agent.subagent.cancel";

/** Mirrors the `lineageOutcome` zod enum in
 * packages/oxagen/src/contracts/lineage.query.ts — kept as a plain union here
 * so this module has no dependency on @oxagen/oxagen. */
export type LineageOutcome =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Derive a run's `outcome` from the raw DB `status` + `error_reason` — never
 * pass `status` through raw. `subagent_runs.status` is DB-constrained to
 * pending|running|completed|failed; a cancel sets status='failed' with
 * error_reason=CANCEL_ERROR_REASON, which this decodes to 'cancelled' so a
 * cancelled run is never mistaken for a genuine failure.
 */
export function deriveLineageOutcome(
  status: string,
  errorReason: string | null,
): LineageOutcome {
  if (status === "failed") {
    return errorReason === CANCEL_ERROR_REASON ? "cancelled" : "failed";
  }
  if (status === "pending" || status === "running" || status === "completed") {
    return status;
  }
  // Defensive: subagent_runs.status is DB-constrained to
  // pending|running|completed|failed, so this should be unreachable.
  return "failed";
}
