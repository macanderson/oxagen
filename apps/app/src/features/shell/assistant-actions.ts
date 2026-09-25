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
//
// `readReplyCost` is the other half of a turn: what the run it was recorded as
// cost, read from that run's cost record on demand (#4167). It is a
// `kernelRead` here rather than a DataSource port because a "use server"
// feature module reads on demand through the kernel seam (ADR-089, ADR-167).
import { assistantReplyGet } from "@oxagen/oxagen/contracts/assistant.reply.get";
import { assistantTurnCancel } from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import type { Cost } from "@/data/contracts/money";
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
 * What one reply cost, as the run's cost record says it (`get_run_cost`).
 *
 * `pending`: no rollup has priced the run yet, so the cost is not known. It is
 * never a zero. `recorded`: the rollup has built the run's row. Its `cost` is
 * null when the rollup priced none of the run's model calls, and a zero only
 * when the calls it priced cost nothing.
 */
export type ReplyCost =
  | { kind: "pending" }
  | {
      kind: "recorded";
      /** The run's priced cost, with the basis the rollup recorded. */
      cost: Cost | null;
      /** The models the rollup priced, as the record names them. */
      models: readonly string[];
      /** The row was built while the run was open, so the figure may grow. */
      estimate: boolean;
      /** Some model call went unpriced, so `cost` covers only the priced ones. */
      incomplete: boolean;
    };

/**
 * Read what the turn recorded as `runId` cost, in the workspace it was asked
 * in. The flyout calls it once a reply lands and once more if the first read
 * came back pending (`use-reply-cost.ts`).
 */
export async function readReplyCost(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<ReplyCost>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: runCostGet,
    input: { runId },
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  const { rollup } = read.value;
  if (rollup === null) return { ok: true, value: { kind: "pending" } };
  return {
    ok: true,
    value: {
      kind: "recorded",
      cost: rollup.cost,
      models: rollup.byModel.map((row) => row.model),
      estimate: rollup.isEstimate,
      incomplete: rollup.byModel.some((row) => row.hasUnpriced),
    },
  };
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
