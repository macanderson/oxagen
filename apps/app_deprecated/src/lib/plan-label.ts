import type { PlanTier } from "@oxagen/oxagen/types";

/**
 * Human-readable subscription-plan labels for UI chrome (the org picker, org
 * settings). Mirrors `resolveOrgTier`'s precedence — the authoritative tier is
 * the active subscription's `plans.tier`, falling back to the org's legacy
 * `plan_type`, then "free" — but resolves it inline from columns already
 * fetched, so the picker needs no extra per-org billing query.
 *
 * Display strings are intentionally simple; pricing copy lives in
 * `@oxagen/billing` `SUBSCRIPTION_PLANS`. Keep this the single source for the
 * tier→label mapping so the picker and settings never drift.
 */
export const TIER_LABELS: Record<PlanTier, string> = {
  free: "Free",
  build: "Build",
  scale: "Scale",
  enterprise: "Enterprise",
};

export const VALID_TIERS = new Set<PlanTier>([
  "free",
  "build",
  "scale",
  "enterprise",
]);

function isTier(value: string | null | undefined): value is PlanTier {
  return value != null && VALID_TIERS.has(value as PlanTier);
}

/** Label for a tier string (defaults to "Free" when unknown/null). */
export function planTierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[isTier(tier) ? tier : "free"];
}

/**
 * Resolve a plan label from the two columns the org query already has:
 * the active subscription's plan tier (authoritative) and the org's legacy
 * `plan_type` fallback.
 */
export function planLabelFrom(
  subscriptionTier: string | null | undefined,
  legacyPlanType: string | null | undefined,
): string {
  if (isTier(subscriptionTier)) return TIER_LABELS[subscriptionTier];
  return planTierLabel(legacyPlanType);
}
