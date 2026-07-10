import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerStripeConfigure } from "@oxagen/oxagen/contracts/billing.reseller_stripe.configure";
import { configureResellerStripe } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerStripeConfigureHandler: CapabilityHandler<
  typeof resellerStripeConfigure
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return configureResellerStripe(rc, {
    secretKey: input.secretKey,
    accountLabel: input.accountLabel ?? null,
  });
};
