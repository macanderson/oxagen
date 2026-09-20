"use server";
// The commands an operator sends to a run from its row on Fleet (spec §7.4),
// through the kernel seam for the workspace viewer the URL names.
//
// The same `dispatch_command` contract the run's own header calls, with the
// same run target, and only the three commands that carry no prompt content.
// A steer stays on the run page: the contract requires `payload` on it, and
// the text and its delivery mode need the room that dialog gives them.
//
// The command is queued, not applied. A pause takes effect at the next
// boundary the harness reaches and a cancel revokes the run token on a
// best-effort basis, so this answers the command ids the control plane wrote
// and the row says Oxagen took the command rather than that the agent stopped.
import {
  COMMAND_REASON_MAX,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** The commands a row sends. `dispatch_command` refuses a payload on all three. */
export const ROW_COMMANDS = ["pause", "resume", "cancel"] as const;
export type RowCommand = (typeof ROW_COMMANDS)[number];

export type QueuedRowCommand = { commandIds: string[] };

function isRowCommand(value: string): value is RowCommand {
  return (ROW_COMMANDS as readonly string[]).includes(value);
}

/**
 * Queue a pause, resume or cancel for one run. The reason is optional and
 * reaches the model on resume; an empty one is omitted rather than sent as a
 * blank string the contract's `min(1)` would refuse.
 *
 * A server action is an endpoint, so the command is checked against the three
 * this surface sends before the kernel runs. Without that, `steer` and
 * `message` would reach the contract from here with no payload and come back
 * as a schema refusal with nothing a person could act on.
 */
export async function dispatchRunCommand(
  org: string,
  ws: string,
  runId: string,
  command: string,
  reason: string,
): Promise<ActionResult<QueuedRowCommand>> {
  const ctx = await requireViewer(org, ws);
  if (!isRowCommand(command)) {
    return {
      ok: false,
      reason: "invalid",
      code: "row_command",
      field: "command",
    };
  }
  const trimmed = reason.trim();
  if (trimmed.length > COMMAND_REASON_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    };
  }
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { commandIds: result.value.commandIds } }
    : result;
}
