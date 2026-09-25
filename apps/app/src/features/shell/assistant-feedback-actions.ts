"use server";
// A person's verdict on one assistant reply (#4169). `record_reply_feedback`
// checks that the run is an assistant run in this workspace whose reply sits
// in the person's own conversation, then appends the vote to ClickHouse
// against the run. A second vote is a second row, and the newest one counts.
//
// Workspace-scoped, like the turn it rates: the flyout passes the workspace
// the thread was asked in.
import { assistantReplyFeedbackRecord } from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type ReplyVerdict = "useful" | "wrong";

export type RecordedReplyFeedback = {
  runId: string;
  verdict: ReplyVerdict;
  /** RFC 3339: when the vote was recorded. */
  recordedAt: string;
};

/**
 * Record `verdict` on the reply `runId` was recorded as, inside `ws`.
 *
 * `note` is the person's reason, or null for none. The contract trims it and
 * refuses one past its cap, so the composer caps it at the same length.
 */
export async function recordReplyFeedback(
  org: string,
  ws: string,
  input: {
    conversationId: string;
    runId: string;
    verdict: ReplyVerdict;
    note: string | null;
  },
): Promise<ActionResult<RecordedReplyFeedback>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, assistantReplyFeedbackRecord, {
    conversationId: input.conversationId,
    runId: input.runId,
    verdict: input.verdict,
    note: input.note,
  });
}
