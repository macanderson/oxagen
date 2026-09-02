// enterprise.ts — server-side helper for gating SOC 2 / compliance features
// behind the Enterprise subscription plan.
//
// SOC 2 compliance tooling (filterable + exportable audit trail, evidence
// bundles, SIEM streaming, access-review exports) is an Enterprise-tier
// feature. The product decision (docs/architecture/security/
// soc2-simplification.html) is to ALWAYS render these surfaces — so a
// prospect on a lower tier can see exactly what they would get — but disable
// every action and enforce the tier server-side.
//
// UI components import `getEnterpriseAccess` in a Server Component to decide
// whether to show the upsell banner and disable controls. Server actions and
// route handlers must additionally call `assertEnterprise` (which throws a
// typed TierDeniedError) so the gate cannot be bypassed by hitting the
// endpoint directly — the disabled button is cosmetic; this is the real lock.

import { resolveOrgTier, meetsMinimumTier, requireTier } from "@oxagen/billing";
import type { PlanTier } from "@oxagen/oxagen/types";

/** The minimum tier required for any SOC 2 / compliance feature. */
export const SOC2_MIN_TIER: PlanTier = "enterprise";

export interface EnterpriseAccess {
  tier: PlanTier;
  isEnterprise: boolean;
}

/**
 * Resolve an org's tier and whether it unlocks Enterprise compliance features.
 * Pure read (no Stripe). Call once per page and thread `isEnterprise` into the
 * UI to toggle the upsell banner + disabled state.
 */
export async function getEnterpriseAccess(
  orgId: string,
): Promise<EnterpriseAccess> {
  const tier = await resolveOrgTier(orgId);
  return { tier, isEnterprise: meetsMinimumTier(tier, SOC2_MIN_TIER) };
}

/**
 * Hard gate for server actions / route handlers behind an Enterprise compliance
 * feature. Throws `TierDeniedError` (catch with `isTierDenied`) when the org is
 * below Enterprise. `feature` is surfaced in the error message for triage.
 */
export async function assertEnterprise(
  orgId: string,
  feature: string,
): Promise<void> {
  const tier = await resolveOrgTier(orgId);
  requireTier(tier, SOC2_MIN_TIER, feature);
}
