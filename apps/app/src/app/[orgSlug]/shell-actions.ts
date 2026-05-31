"use server";
/**
 * shell-actions.ts — org-level shell stub actions for the AskDrawer.
 *
 * When the AskDrawer is rendered in an org-level shell (no workspace context),
 * these stubs are used. They return graceful errors so the drawer renders
 * without crashing. The user is directed to pick a workspace to use full chat.
 */

export async function orgShellSendAction(
  _formData: FormData,
): Promise<{ ok: false; error: string }> {
  return { ok: false, error: "Select a workspace to start chatting." };
}

export async function orgShellResolveApprovalAction(
  _approvalId: string,
  _decision: "approved" | "denied",
): Promise<{ ok: false; error: string }> {
  return { ok: false, error: "No active workspace." };
}

export async function orgShellResolvePlanAction(
  _planId: string,
  _decision: "approved" | "denied" | "amended",
  _amendedSteps?: import("@/components/chat/stream-event-types").PlanStep[],
): Promise<{ ok: false; error: string }> {
  return { ok: false, error: "No active workspace." };
}
