import { requireEnv } from "@oxagen/config/env";

/**
 * The outcome of applying the usage-purchase volume discount to a customer-
 * defined grant amount.
 */
export interface UsageDiscount {
  /** The pre-discount grant amount (face value of credits the customer wants), in USD cents. */
  grantCents: number;
  /** Whole discount increments earned (floor(min(grant,ceiling) / increment)). */
  increments: number;
  /** Discount applied as a percentage, e.g. 15 for 15%. */
  percent: number;
  /** Amount the customer is actually charged, in USD cents (grant − savings). */
  priceCents: number;
  /** Amount saved versus the face value, in USD cents. */
  savedCents: number;
}

/**
 * Volume discount for a usage-credit purchase.
 *
 * A customer chooses how much usage (grant) they want, in dollars. They earn
 * `OXAGEN_USAGE_DISCOUNT_PERCENT`% off for every `OXAGEN_USAGE_DISCOUNT_INCREMENT`
 * dollars of grant, scaling from $0 up to `OXAGEN_USAGE_DISCOUNT_CEILING_USD`
 * (above which the discount stays flat at its max). They still receive the full
 * face-value grant in credits; the discount lowers the price they pay.
 *
 * Defaults (3% per $50, ceiling $250) ⇒ 15% max at $250:
 *   $50 → 3% · $100 → 6% · $150 → 9% · $200 → 12% · $250 → 15% · $300 → 15% (capped)
 *
 * The percent applies to the whole grant (not marginal/tiered per band).
 *
 * @param grantCents customer-chosen usage grant amount, in USD cents (≥ 0).
 */
export function usageVolumeDiscount(grantCents: number): UsageDiscount {
  if (!Number.isFinite(grantCents) || grantCents < 0) {
    throw new RangeError(
      `usageVolumeDiscount: grantCents must be a non-negative number, got ${grantCents}`,
    );
  }
  const env = requireEnv([
    "OXAGEN_USAGE_DISCOUNT_PERCENT",
    "OXAGEN_USAGE_DISCOUNT_INCREMENT",
    "OXAGEN_USAGE_DISCOUNT_CEILING_USD",
  ] as const);
  const percentPerIncrement = env.OXAGEN_USAGE_DISCOUNT_PERCENT;
  const incrementUsd = env.OXAGEN_USAGE_DISCOUNT_INCREMENT;
  const ceilingUsd = env.OXAGEN_USAGE_DISCOUNT_CEILING_USD;

  const grantUsd = grantCents / 100;
  const eligibleUsd = Math.min(grantUsd, ceilingUsd);
  const increments = Math.floor(eligibleUsd / incrementUsd);
  const percent = increments * percentPerIncrement;
  // Round half-up to the nearest cent so the customer is never over-charged by
  // a sub-cent rounding error.
  const savedCents = Math.round((grantCents * percent) / 100);
  const priceCents = grantCents - savedCents;

  return { grantCents, increments, percent, priceCents, savedCents };
}
