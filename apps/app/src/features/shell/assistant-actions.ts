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
import { assistantReplyGet } from "@oxagen/oxagen/contracts/assistant.reply.get";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** What the record holds for a turn's run. */
export type AssistantReplyRead =
  /** The reply is saved, in the conversation the next question continues. */
  | { state: "answered"; conversationId: string; reply: string }
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
      },
    };
  }
  const ended = runStatus === "failed" || runStatus === "cancelled";
  return { ok: true, value: { state: ended ? "ended" : "running" } };
}
