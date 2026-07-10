import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerRebillPreview } from "@oxagen/oxagen/contracts/billing.reseller_rebill.preview";
import { previewResellerRebill } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerRebillPreviewHandler: CapabilityHandler<
  typeof resellerRebillPreview
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return previewResellerRebill(rc, {
    start: input.start,
    end: input.end,
    customerId: input.customerId,
  });
};
