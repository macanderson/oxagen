// audit-exempt: read-only list of reseller price plans — no state change; covered by the kernel capability.invoke_* audit.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerPricePlanList } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.list";
import { listResellerPricePlans } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerPricePlanListHandler: CapabilityHandler<
  typeof resellerPricePlanList
> = async (_input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const pricePlans = await listResellerPricePlans(rc);
  return { pricePlans };
};
