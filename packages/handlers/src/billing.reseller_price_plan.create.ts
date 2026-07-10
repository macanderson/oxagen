import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerPricePlanCreate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.create";
import { createResellerPricePlan } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerPricePlanCreateHandler: CapabilityHandler<
  typeof resellerPricePlanCreate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const pricePlan = await createResellerPricePlan(rc, {
    name: input.name,
    pricingMode: input.pricingMode,
    markupBps: input.markupBps ?? null,
    unitPriceCents: input.unitPriceCents ?? null,
    currency: input.currency,
  });
  return { pricePlan };
};
