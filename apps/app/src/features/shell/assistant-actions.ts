"use server";
// The finished reply of a turn whose stream dropped (ADR-176). A turn streams
// to the flyout over the API's chat stream (assistant-stream-client.ts), and
// a dropped connection does not stop it: it runs to completion and persists
// its reply (ADR-092). This reads that reply back by the run the stream named,
// through `get_assistant_reply`, on demand, so it lives in a "use server"
// module that resolves its own viewer (ADR-089).
//
// Workspace-scoped, because a turn and its reply belong to the workspace the
// question was asked in. The flyout passes that workspace, not the one the
// person is standing in now.
//
// It also holds the stop (#4164). The flyout names each turn with a `turnId`
// it mints and sends in the stream request, so the person can stop it. The
// flyout posts the stop to the `assistant/stop` route, which calls
// `stopAssistantTurn` here.
import { assistantReplyGet } from "@oxagen/oxagen/contracts/assistant.reply.get";
import { assistantTurnCancel } from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** What the record holds for a turn's run. */
export type AssistantReplyRead =
  /**
   * The reply is saved, in the conversation the next question continues.
   * `stopped` is true when the person stopped the turn (#4164): its run is
   * sealed cancelled and `reply` is what it wrote before the stop.
   */
  | {
      state: "answered";
      conversationId: string;
      reply: string;
      stopped: boolean;
    }
  /**
   * No reply yet. The turn is still running, or it has just finished and its
   * reply is still being saved.
   */
  | { state: "running" }
  /** The turn failed or was cancelled, and no reply will be saved. */
  | { state: "ended" };

/** Read the finished reply of the turn recorded as `runId` in `ws`. */
export async function readAssistantReply(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<AssistantReplyRead>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: assistantReplyGet,
    input: { runId },
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  const { reply, runStatus } = read.value;
  if (reply !== null) {
    return {
      ok: true,
      value: {
        state: "answered",
        conversationId: reply.conversationId,
        reply: reply.text,
        // A disconnect and a budget stop save no reply, so a cancelled run
        // that left one was stopped by the person who asked.
        stopped: runStatus === "cancelled",
      },
    };
  }
  const ended = runStatus === "failed" || runStatus === "cancelled";
  return { ok: true, value: { state: ended ? "ended" : "running" } };
}

/**
 * Stop the viewer's own turn that is still running under `turnId` (#4164).
 * `found` is false when no such turn is running: it ended, it was already
 * stopped, or it has not started yet, in which case the stop is held and
 * applied when it does. Only the person who asked can stop a
 * turn, so another person's `turnId` also answers `found: false`.
 */
export async function stopAssistantTurn(
  org: string,
  ws: string,
  turnId: string,
): Promise<ActionResult<{ turnId: string; found: boolean }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, assistantTurnCancel, { turnId });
}
