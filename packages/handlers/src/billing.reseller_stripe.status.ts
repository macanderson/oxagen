// audit-exempt: read-only reseller Stripe connection status — no state change; the mutating path (billing.reseller_stripe.configure) emits billing.reseller_stripe_configured.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerStripeStatus } from "@oxagen/oxagen/contracts/billing.reseller_stripe.status";
import { getResellerStripeStatus } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerStripeStatusHandler: CapabilityHandler<
  typeof resellerStripeStatus
> = async (_input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return getResellerStripeStatus(rc);
};
