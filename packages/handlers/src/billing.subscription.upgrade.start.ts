import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
import { createCheckoutSession } from "@oxagen/billing";

export const billingSubscriptionUpgradeStartHandler: CapabilityHandler<
  typeof billingSubscriptionUpgradeStart
> = async (input, ctx) => {
  // Authorization guard: a resolved principal is required, and the request
  // must be scoped to a specific org. Upgrade is a mutating billing action —
  // it must never proceed on behalf of an anonymous or unscoped caller.
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    throw new Error("Forbidden: orgId is required to start a subscription upgrade");
  }

  const { url } = await createCheckoutSession({
    orgId: ctx.orgId,
    planSlug: input.planSlug,
    interval: input.interval,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });
  return { checkoutUrl: url, planSlug: input.planSlug, interval: input.interval };
};
