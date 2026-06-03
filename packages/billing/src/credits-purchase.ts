/**
 * credits-purchase.ts — Dynamic usage-credit purchase via Stripe Checkout.
 *
 * A customer chooses how much usage (the grant, in USD) they want to buy.
 * They receive the full face-value in credits but pay a discounted price per
 * the volume-discount schedule (see discount.ts).
 *
 * 1 credit = 1¢ (CREDIT_VALUE_USD = 0.01).
 * The customer receives `grantCents` credits regardless of what they paid.
 * The discount is the incentive for larger purchases; credits are still
 * denominated at face value.
 */

import { requireEnv } from "@oxagen/config/env";
import { billingProvider } from "./client";
import { ensureStripeCustomer } from "./customers";
import { usageVolumeDiscount } from "./discount";
import { resolveOrgTier } from "./tier";
import { canBuyCredits, TierDeniedError } from "./entitlements";
import { logger } from "./logger";

/** Minimum grant: $5.00 = 500 cents. Free orgs need at least this much to get value. */
export const MIN_GRANT_CENTS = 500;

export interface CreateUsageCreditCheckoutInput {
  /** Org id for the purchasing customer. */
  orgId: string;
  /**
   * The face-value amount the customer wants to receive as usage credits,
   * in USD cents. Must be at least MIN_GRANT_CENTS (500 = $5).
   * 1 credit = 1¢, so grantCents === number of credits granted.
   */
  grantCents: number;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CreateUsageCreditCheckoutResult {
  /** Stripe Checkout URL to redirect the customer to. */
  url: string;
  /** Stripe Checkout session id. */
  sessionId: string;
  /** Face-value credits the customer will receive (= grantCents). */
  grantCents: number;
  /** Amount the customer will actually pay, in USD cents (after discount). */
  priceCents: number;
  /** Discount percentage applied, e.g. 15 for 15% off. */
  percent: number;
}

/**
 * Create a Stripe Checkout session for a dynamic usage-credit purchase.
 *
 * - Validates the grant amount (≥ MIN_GRANT_CENTS, positive integer).
 * - Applies the volume discount via `usageVolumeDiscount`.
 * - Ensures a Stripe customer exists for the org.
 * - Creates a Checkout session with inline `price_data` (no pre-made Price).
 * - Session metadata carries `credits` = grantCents (face value) for the
 *   webhook grant path (grantCreditPackForCheckout reads it as a fallback).
 *
 * Throws {@link TierDeniedError} when the org is on the Free tier.
 * Throws {@link RangeError} when grantCents < MIN_GRANT_CENTS or non-integer.
 */
export async function createUsageCreditCheckout(
  input: CreateUsageCreditCheckoutInput,
): Promise<CreateUsageCreditCheckoutResult> {
  const { orgId, grantCents } = input;

  if (!Number.isInteger(grantCents) || grantCents < MIN_GRANT_CENTS) {
    throw new RangeError(
      `createUsageCreditCheckout: grantCents must be an integer ≥ ${MIN_GRANT_CENTS}, got ${grantCents}`,
    );
  }

  // Plan-tier gate: Free orgs cannot purchase credits — they must subscribe first.
  const tier = await resolveOrgTier(orgId);
  if (!canBuyCredits(tier)) {
    throw new TierDeniedError(tier, "build", "usage-credit-purchase");
  }

  const discount = usageVolumeDiscount(grantCents);
  const customerId = await ensureStripeCustomer(orgId);

  const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);

  const result = await billingProvider().createDynamicCreditCheckout({
    customerId,
    orgId,
    priceCents: discount.priceCents,
    grantCents: discount.grantCents,
    discountPercent: discount.percent,
    successUrl:
      input.successUrl ??
      `${env.NEXT_PUBLIC_APP_URL}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: input.cancelUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/credits`,
  });

  logger.info(
    {
      orgId,
      grantCents: discount.grantCents,
      priceCents: discount.priceCents,
      savedCents: discount.savedCents,
      percent: discount.percent,
      sessionId: result.sessionId,
    },
    "billing: created dynamic usage-credit checkout session",
  );

  return {
    url: result.url,
    sessionId: result.sessionId,
    grantCents: discount.grantCents,
    priceCents: discount.priceCents,
    percent: discount.percent,
  };
}
