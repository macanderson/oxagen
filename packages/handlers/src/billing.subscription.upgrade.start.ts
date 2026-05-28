import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
import { createCheckoutSession } from "@oxagen/billing";

export const billingSubscriptionUpgradeStartHandler: CapabilityHandler<
  typeof billingSubscriptionUpgradeStart
> = async (input, ctx) => {
  const { url } = await createCheckoutSession({
    tenantId: ctx.tenantId,
    planSlug: input.planSlug,
    interval: input.interval,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });
  return { checkoutUrl: url, planSlug: input.planSlug, interval: input.interval };
};
