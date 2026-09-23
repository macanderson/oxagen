import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingCreditsPurchase } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { createUsageCreditCheckout } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";

/**
 * purchase_credits — top up the organisation's in-app AI usage credit balance
 * through Stripe Checkout (apps/app/ARCHITECTURE.md §1.4, §3.9 "the second
 * meter"). Credits pay for the in-app agent's model calls on the platform key
 * at provider cost, with no markup (`ASSISTANT_TOKEN_MARKUP` is 1, ADR-053 §3
 * as amended 2026-09-18); 1 credit = $0.01. The Stripe webhook grants the
 * credits after payment, so this handler grants nothing itself.
 *
 * Role gate — `assertOrgRole`: org Owner or Billing, for the signed-in user or
 * the creator of the API key (`resolveActingUserId`), who is recorded as the
 * actor. The kernel's IAM check allows every capability for a non-enterprise
 * org, so the handler owns this check (§3.2, INV-29). Before WL-67 this
 * handler asked only that some principal existed, which let any member of a
 * Free, Build or Scale org start a top-up.
 *
 * The contract is `noBillingGate: true` (INV-27): buying credits is never
 * refused for lack of governed action units.
 */
export const billingCreditsPurchaseHandler: CapabilityHandler<
  typeof billingCreditsPurchase
> = async (input, ctx) => {
  // The role gate and the acting-user lookup both read tables scoped to this
  // org, so the scope is required before either runs.
  if (!ctx.orgId) {
    logger.warn({}, "billing.credits.purchase: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required to purchase usage credits");
  }

  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Billing"] },
  );

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
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId ?? null,
      capability: billingCreditsPurchase.name,
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
