"use server";
// Turn the workspace's operator pseudonyms on or off (set_operator_pseudonyms,
// spec "Operator ranking"). The handler admits an org Owner or Admin and
// writes a security event for each change. It runs through kernelWrite, the
// seam's one path for a call a person starts from a page, and is
// noBillingGate (INV-28).
import { spendOperatorPseudonymsSet } from "@oxagen/oxagen/contracts/spend.operator_pseudonyms.set";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { SpendAt } from "./view";

export async function setOperatorPseudonymsAction(
  at: SpendAt,
  enabled: boolean,
): Promise<ActionResult<{ pseudonyms: boolean }>> {
  const ctx = await requireViewer(at.org, at.ws);
  return kernelWrite(ctx, spendOperatorPseudonymsSet, { enabled });
}
