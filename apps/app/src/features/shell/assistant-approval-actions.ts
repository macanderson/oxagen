"use server";
// What the approval rows say about the writes one assistant turn parked. The
// flyout draws each parked write as a card with Approve and Deny, and a card
// shows the state its row records, never a state the flyout remembers: a
// person on Fleet, a second viewer, the expiry sweep and the handler's own
// delivery all change the row, and each has to read the same way in both
// places (ADR-118, #3127).
//
// Every call a turn parks records the turn's run (`run_public_id`, #3286), so
// one read narrowed to that run answers every card of the turn. The two halves
// are the approvals port's `pending` and `resolved`, the reads the Run page's
// Governed actions tab makes, so the flyout reuses their kernel call, mapping
// and view-model check rather than copying them (ADR-167 names this module).
import { dataSource } from "@/data/source";
import type { ActionResult } from "@/server/kernel";
import { readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** What became of an approved call, as the row records it (ADR-118). */
export type ParkedExecution = {
  status: string;
  runId: string | null;
  reason: string | null;
};

/** One parked write's row, keyed by the approval's public id (`apr_…`). */
export type ParkedApprovalRow =
  | { id: string; state: "waiting"; expiresAt: string }
  | {
      id: string;
      state: "approved" | "denied" | "expired";
      /** `user:<usr_…>` or `policy:<rule id>`; null when neither is recorded. */
      resolvedBy: string | null;
      resolvedAt: string;
      execution: ParkedExecution | null;
    };

export type ParkedApprovalRows = { rows: ParkedApprovalRow[] };

/**
 * The pending and resolved approvals recorded on `runId`, the run the turn was
 * recorded as. A parked write in neither list is one the record no longer
 * holds as pending and never resolved, which the card reads as expired once its
 * deadline has passed.
 */
export async function readParkedApprovals(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<ParkedApprovalRows>> {
  const ctx = await requireViewer(org, ws);
  const source = dataSource();
  const [pending, resolved] = await Promise.all([
    source.approvals.pending(ctx, { runId }),
    source.approvals.resolved(ctx, { runId }),
  ]);
  if (!pending.ok) return readToActionResult(pending);
  if (!resolved.ok) return readToActionResult(resolved);
  const rows: ParkedApprovalRow[] = [
    ...pending.value.items.map(
      (item): ParkedApprovalRow => ({
        id: item.id,
        state: "waiting",
        expiresAt: item.expiresAt,
      }),
    ),
    ...resolved.value.map(
      (item): ParkedApprovalRow => ({
        id: item.id,
        state: item.resolution,
        resolvedBy: item.resolvedBy,
        resolvedAt: item.resolvedAt,
        execution: item.execution ?? null,
      }),
    ),
  ];
  return { ok: true, value: { rows } };
}
