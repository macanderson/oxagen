import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { createCheckoutSession } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { logger } from "./logger";

/**
 * start_subscription_upgrade — begin a Stripe Checkout session for a plan
 * change from the Billing page's "Change plan" dialog.
 *
 * Role gate — `assertOrgRole`: org Owner or Billing, for the signed-in user
 * or the creator of the API key (`resolveActingUserId`), who is recorded as
 * the actor. The kernel's IAM check allows every capability for a
 * non-enterprise org, so the handler owns this check (§3.2, INV-29); without
 * it, any member of a Free, Build or Scale org could open a plan-change
 * Checkout.
 *
 * The contract declares `noBillingGate: true` (INV-27): a prepaid org at
 * remaining = 0 is the one that needs to upgrade, and metering the Checkout
 * start as a governed action refused it.
 *
 * `createCheckoutSession` refuses with `ActiveSubscriptionError` when the org
 * already has an active or trialing subscription (`changeOrgPlan` is the
 * in-place swap); that refusal is reclassified below into a `HandlerError`
 * with `code: "conflict"` so the app's kernel seam surfaces it as a `conflict`
 * result instead of an unclassified error.
 */
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

  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Billing"] },
  );

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
    if (
      err instanceof Error &&
      (err as { code?: unknown }).code === "active_subscription_exists"
    ) {
      logger.warn(
        { err, orgId: ctx.orgId, planSlug: input.planSlug },
        "billing.subscription.upgrade.start: org already has an active subscription",
      );
      throw new HandlerError({
        code: "conflict",
        reason: "active_subscription_exists",
      });
    }
    logger.error(
      { err, orgId: ctx.orgId, planSlug: input.planSlug },
      "billing.subscription.upgrade.start: createCheckoutSession failed",
    );
    throw err;
  }
};
