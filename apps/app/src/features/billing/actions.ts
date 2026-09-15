"use server";
// The Billing page's writes. Auto top-up: whether the recorder charges the
// saved card when the bucket runs out, and for how many blocks, through
// set_auto_topup on the kernel seam. The handler checks the role (Owner or
// Admin, INV-29) and returns the two fields as stored.
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Blocks charged per top-up: the contract's and the column's bounds. */
const MIN_BLOCKS = 1;
const MAX_BLOCKS = 100;

/**
 * Blocks that are not an integer in 1…100 are `invalid` on the `blocks` field
 * and no capability runs.
 */
export async function setAutoTopup(
  org: string,
  input: { enabled: boolean; blocks: number },
): Promise<ActionResult<ContractOutput<typeof billingAutoTopupSet>>> {
  const ctx = await requireViewer(org);
  const { enabled, blocks } = input;
  if (!Number.isInteger(blocks) || blocks < MIN_BLOCKS || blocks > MAX_BLOCKS)
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "blocks",
    };
  return kernelWrite(ctx, billingAutoTopupSet, { enabled, blocks });
}
