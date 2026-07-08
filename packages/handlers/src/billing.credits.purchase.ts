import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingCreditsPurchase } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { createUsageCreditCheckout } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

export const billingCreditsPurchaseHandler: CapabilityHandler<
  typeof billingCreditsPurchase
> = async (input, ctx) => {
  // Authorization guard: a resolved principal is required, and the request
  // must be scoped to a specific org. Credit purchase is a mutating billing
  // action — it must never proceed on behalf of an anonymous or unscoped caller.
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "billing.credits.purchase: rejected — no authenticated principal",
    );
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "billing.credits.purchase: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required to purchase usage credits");
  }

  // Convert the customer-facing dollar amount to cents.
  // amountUsd is validated by the contract schema (≥ 5, positive).
  const grantCents = Math.round(input.amountUsd * 100);

  try {
    const result = await createUsageCreditCheckout({
      orgId: ctx.orgId,
      grantCents,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });

    // ── Emit audit event (fire-and-forget) ────────────────────────────────────
    emitSecurityEvent({
      eventType: "billing.checkout_initiated",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId ?? null,
      capability: "purchase_credits",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        amountUsd: input.amountUsd,
        grantCents: result.grantCents,
        priceCents: result.priceCents,
        percent: result.percent,
        surface: ctx.surface,
      },
      "billing.credits.purchase: checkout session created successfully",
    );

    return {
      url: result.url,
      grantCents: result.grantCents,
      priceCents: result.priceCents,
      percent: result.percent,
    };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, amountUsd: input.amountUsd },
      "billing.credits.purchase: createUsageCreditCheckout failed",
    );
    throw err;
  }
};
