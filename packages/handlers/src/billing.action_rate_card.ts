// audit-exempt: read-only — publishes static rate-card constants plus the caller's own tier; mutates nothing. The kernel capability.invoke_* audit covers access.
/**
 * get_rate_card handler (ADR-052, spec §4).
 *
 * Almost entirely constants: the volume bands, the per-tier allowances, the
 * retention price and the zero model-token rate all live in
 * `@oxagen/billing`'s `action-metering.ts`, which is the single place the rate
 * card is written down. Restating any of them here would create a second rate
 * card that could disagree with the one that charges.
 *
 * The one organisation-specific read is the caller's own tier and allowance,
 * so the published table can be read against their own position in it.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingActionRateCard } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import type { PlanTier } from "@oxagen/oxagen/types";
import {
  ACTION_RATE_BANDS,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  TIER_ACTION_ALLOWANCES,
  resolveActionAllowance,
  resolveOrgActionEntitlement,
} from "@oxagen/billing";
import { logger } from "./logger";

/** Published tier order — cheapest first, so the table reads as a ladder. */
const TIER_ORDER: readonly PlanTier[] = [
  "free",
  "build",
  "scale",
  "enterprise",
];

/**
 * Evidence retention included on `free`, in months.
 *
 * Spec §4.2 gives `free` thirty days where every paid tier gets twelve months.
 * The contract's field is whole months, so thirty days is published as one —
 * rounding a published figure DOWN to the nearest unit the schema can carry
 * cannot overstate what a customer is entitled to. The paid tiers read
 * {@link RETENTION_INCLUDED_MONTHS}, which is the constant the charge uses.
 */
const FREE_TIER_RETENTION_MONTHS = 1;

function retentionMonthsForTier(tier: PlanTier): number {
  return tier === "free"
    ? FREE_TIER_RETENTION_MONTHS
    : RETENTION_INCLUDED_MONTHS;
}

export const billingActionRateCardHandler: CapabilityHandler<
  typeof billingActionRateCard
> = async (_input, ctx) => {
  const entitlement = await resolveOrgActionEntitlement(ctx.orgId);
  const yourIncludedActionsAnnual = resolveActionAllowance(
    entitlement.tier,
    entitlement.includedActionsAnnual,
  );

  logger.debug(
    {
      orgId: ctx.orgId,
      tier: entitlement.tier,
      includedActionsAnnual: yourIncludedActionsAnnual,
    },
    "get_rate_card: published the governed-action rate card",
  );

  return {
    unit: "governed_action" as const,
    summary:
      "Oxagen bills one governed action per top-level capability invocation that passes its gates and completes. Actions past your plan's annual allowance price at the volume band your annual total lands in; model tokens are reported in full and charged at zero.",
    bands: ACTION_RATE_BANDS.map((band) => ({
      id: band.id,
      minAnnualActions: band.minAnnualActions,
      maxAnnualActions: band.maxAnnualActions,
      usdPer1000: band.usdPer1000,
    })),
    tiers: TIER_ORDER.map((tier) => ({
      tier,
      // Null on enterprise: negotiated per contract (spec §7.3). Published as
      // "see your agreement", never as unlimited.
      includedActionsAnnual: TIER_ACTION_ALLOWANCES[tier],
      retentionMonths: retentionMonthsForTier(tier),
    })),
    retention: {
      includedMonths: RETENTION_INCLUDED_MONTHS,
      usdPerGbMonth: RETENTION_USD_PER_GB_MONTH,
      // Spec §7.4 — extended retention never accrues without an explicit
      // opt-in, so the literal is the promise, not a placeholder.
      optIn: true as const,
    },
    modelTokens: {
      usdPerToken: 0 as const,
      explanation:
        "Model token spend is reported in full, per run and per capability, and charged at zero. Under BYOK your own provider key already paid the vendor for those tokens, so billing you again would be charging twice for one call. The zero is a line on your invoice, not an omission from it.",
    },
    yourTier: entitlement.tier,
    yourIncludedActionsAnnual,
  };
};
