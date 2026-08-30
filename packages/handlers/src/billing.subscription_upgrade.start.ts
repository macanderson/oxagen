import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { createCheckoutSession } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

export const billingSubscriptionUpgradeStartHandler: CapabilityHandler<
  typeof billingSubscriptionUpgradeStart
> = async (input, ctx) => {
  // Authorization guard: a resolved principal is required, and the request
  // must be scoped to a specific org. Upgrade is a mutating billing action —
  // it must never proceed on behalf of an anonymous or unscoped caller.
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "billing.subscription.upgrade.start: rejected — no authenticated principal",
    );
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn(
      {},
      "billing.subscription.upgrade.start: rejected — missing orgId",
    );
    throw new Error(
      "Forbidden: orgId is required to start a subscription upgrade",
    );
  }

  try {
    const { url } = await createCheckoutSession({
      orgId: ctx.orgId,
      planSlug: input.planSlug,
      interval: input.interval,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
    // ── Emit audit event (fire-and-forget) ────────────────────────────────────
    emitSecurityEvent({
      eventType: "billing.checkout_initiated",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId ?? null,
      capability: "start_subscription_upgrade",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        planSlug: input.planSlug,
        interval: input.interval,
        surface: ctx.surface,
      },
      "billing.subscription.upgrade.start: checkout session created successfully",
    );
    return {
      checkoutUrl: url,
      planSlug: input.planSlug,
      interval: input.interval,
    };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, planSlug: input.planSlug },
      "billing.subscription.upgrade.start: createCheckoutSession failed",
    );
    throw err;
  }
};
