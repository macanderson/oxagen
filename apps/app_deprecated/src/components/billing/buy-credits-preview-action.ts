"use server";
/**
 * buy-credits-preview-action.ts — thin server action to compute the volume
 * discount preview for a given grant amount.
 *
 * The `usageVolumeDiscount` function reads env vars (OXAGEN_USAGE_DISCOUNT_*)
 * which are only available server-side; this action is the safe bridge.
 */
import { usageVolumeDiscount } from "@oxagen/billing";

export interface DiscountPreview {
  grantCents: number;
  priceCents: number;
  percent: number;
  savedCents: number;
}

export async function getDiscountPreview(
  grantCents: number,
): Promise<DiscountPreview> {
  if (!Number.isInteger(grantCents) || grantCents < 0) {
    return { grantCents: 0, priceCents: 0, percent: 0, savedCents: 0 };
  }
  const result = usageVolumeDiscount(grantCents);
  return {
    grantCents: result.grantCents,
    priceCents: result.priceCents,
    percent: result.percent,
    savedCents: result.savedCents,
  };
}
