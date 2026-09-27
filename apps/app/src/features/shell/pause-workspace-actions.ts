"use server";
// ⌘K's "Pause every live run in this workspace" (#3862): one
// `pause_workspace_runs` write through the kernel seam, for the workspace
// viewer the URL names.
//
// The menu calls this capability rather than `dispatch_command` with a
// workspace target. Both queue the same pauses, but this one admits only an
// org Owner or Admin and the workspace Owner, parks an in-app agent's call
// for approval, answers which runs were skipped and why, and records the
// decision as one audit event with its counts.
//
// The reason is required and checked here as well as in the dialog, because
// a server action is an endpoint: an empty or overlong reason is refused
// before the kernel runs. The handler decides who may pause (`assertOrgRole`),
// and a refusal comes back as the action's own result.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import {
  type PauseWorkspaceRunsOutput,
  pauseWorkspaceRuns,
} from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** The receipt: the runs that took the pause, and the runs skipped with why. */
export type WorkspacePause = PauseWorkspaceRunsOutput;

export async function pauseWorkspaceRunsAction(
  org: string,
  ws: string,
  reason: string,
): Promise<ActionResult<WorkspacePause>> {
  const trimmed = reason.trim();
  if (trimmed === "" || trimmed.length > COMMAND_REASON_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: trimmed === "" ? "pause_reason_required" : "command_reason",
      field: "reason",
    };
  }
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, pauseWorkspaceRuns, { reason: trimmed });
}
