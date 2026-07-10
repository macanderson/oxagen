import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerRebillPush } from "@oxagen/oxagen/contracts/billing.reseller_rebill.push";
import { pushResellerRebill } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerRebillPushHandler: CapabilityHandler<
  typeof resellerRebillPush
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return pushResellerRebill(rc, {
    customerId: input.customerId,
    start: input.start,
    end: input.end,
    finalize: input.finalize,
  });
};
