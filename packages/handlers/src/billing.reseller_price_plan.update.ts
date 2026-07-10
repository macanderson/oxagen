import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerPricePlanUpdate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.update";
import { updateResellerPricePlan } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerPricePlanUpdateHandler: CapabilityHandler<
  typeof resellerPricePlanUpdate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const pricePlan = await updateResellerPricePlan(rc, input);
  return { pricePlan };
};
