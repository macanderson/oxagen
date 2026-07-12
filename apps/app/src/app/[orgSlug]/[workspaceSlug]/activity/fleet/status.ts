/**
 * status.ts — pure status → Badge-variant mapping for the Fleet surface.
 *
 * Fan-out status (list_subagent_fanouts / get_subagent_fanout / aggregate_subagents)
 * and child-run status (get_subagent_fanout runs[] / list_subagent_siblings) use
 * distinct, contract-defined enums — neither includes a literal "cancelled" value
 * today. `cancel_subagent` transitions a fanout to "timed_out" and its runs to
 * "failed" (see the HALTED SUB-SLICE note in agent.subagent.cancel's handler —
 * the DB CHECK constraints don't have a "cancelled" value yet, pending a
 * migration). This surface renders the literal status the API returns rather
 * than inventing a "Cancelled" label it cannot actually distinguish.
 *
 * Local to activity/fleet/ rather than extending the shared
 * @/components/activity/format.ts statusBadgeVariant (which only recognizes
 * planning/running/completed/failed/cancelled/pending) — that file belongs to
 * the sibling Activity/Runs surface and is out of scope here.
 */

export type BadgeVariant = "success" | "warning" | "error" | "info" | "muted";

/** Fanout-level status: pending | running | completed | partial | timed_out. */
export function fanoutStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "info";
    case "pending":
      return "muted";
    case "partial":
      return "warning";
    case "timed_out":
      return "warning";
    default:
      return "muted";
  }
}

/** Child-run / sibling status: pending | running | completed | failed. */
export function runStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "error";
    case "pending":
      return "muted";
    default:
      return "muted";
  }
}

/** True when a fanout is still eligible for cancel_subagent (mirrors the handler's own gate). */
export function isFanoutCancellable(status: string): boolean {
  return status === "pending" || status === "running";
}
