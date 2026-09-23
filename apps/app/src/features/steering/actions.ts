"use server";
// The Context PR writes (#2961; ADR-061), each through the kernel seam for the
// workspace viewer the URL names. Every contract is `noBillingGate`.
// open_context_pr and dismiss_proposal gate the acting user's role in their
// handlers (INV-29); merge_context_pr gates the signed-in reviewer the
// governance mode names. A refusal comes back as `denied` or `conflict` with
// the handler's reason as its code, and nothing changed.
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Opens the proposal's Context PR and runs its six checks, or re-runs them on the pull request already open; returns where the machine stopped. */
export async function openContextPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<
  ActionResult<{ status: ContractOutput<typeof contextPrOpen>["status"] }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrOpen, { proposalId });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** Merges the pull request once every check passed; merge publishes the record. */
export async function mergeContextPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrMerge, { proposalId });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/** Dismisses the proposal with a reason; an open pull request for it is closed and its branch deleted. */
export async function dismissProposal(
  org: string,
  ws: string,
  proposalId: string,
  reason: string,
): Promise<ActionResult<{ status: "rejected" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextProposalDismiss, {
    proposalId,
    reason: reason.trim(),
  });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/**
 * Set one of the two steering-freshness gates for the workspace.
 *
 * One gate per call, as a patch. Two checkboxes that each resent both values
 * would let the second person to click overwrite the first person's change
 * with the value their page happened to be rendered with, and a governance
 * gate that silently switches back off is worse than one that was never
 * offered. `update_workspace_settings` merges the named member into the
 * stored block and leaves the other alone.
 *
 * The handler gates the role (INV-29): an org or workspace Owner or Admin
 * writes, anyone else is answered `denied` with nothing changed.
 */
export async function setSteeringGate(
  org: string,
  ws: string,
  gate: "autoSync" | "blockStaleRuns",
  enabled: boolean,
): Promise<ActionResult<{ autoSync: boolean; blockStaleRuns: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workspaceSettingsWrite, {
    steering: { [gate]: enabled },
  });
  return result.ok ? { ok: true, value: result.value.steering } : result;
}
