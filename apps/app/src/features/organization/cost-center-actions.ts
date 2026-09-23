"use server";
// The Cost centers section's writes (ADR-142): add a label to the
// organization's list, delete one, and charge a workspace to one. Each runs
// through kernelWrite in the viewer's context; each is noBillingGate and
// checked in its handler for an org Owner, Admin or Billing member, so a
// refusal comes back as `denied` with nothing changed.
import { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type CostCenterDraft = { label: string; description: string };

export async function createCostCenter(
  org: string,
  draft: CostCenterDraft,
): Promise<ActionResult<{ label: string }>> {
  const ctx = await requireViewer(org);
  const description = draft.description.trim();
  const result = await kernelWrite(ctx, costCenterCreate, {
    label: draft.label.trim(),
    ...(description === "" ? {} : { description }),
  });
  return result.ok
    ? { ok: true, value: { label: result.value.costCenter.label } }
    : result;
}

export async function deleteCostCenter(
  org: string,
  label: string,
): Promise<ActionResult<{ label: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, costCenterDelete, { label });
  return result.ok
    ? { ok: true, value: { label: result.value.label } }
    : result;
}

/** Charge one workspace to a label, or clear it with the empty string. */
export async function setWorkspaceCostCenter(
  org: string,
  workspaceSlug: string,
  label: string,
): Promise<ActionResult<{ costCenter: string | null }>> {
  // set_cost_center is workspace-scoped, so it runs in that workspace.
  const ctx = await requireViewer(org, workspaceSlug);
  const result = await kernelWrite(ctx, costCenterSet, {
    target: "workspace",
    costCenter: label === "" ? null : label,
  });
  return result.ok
    ? { ok: true, value: { costCenter: result.value.costCenter } }
    : result;
}
