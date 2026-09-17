/**
 * plan-allowance.ts — the organisation's governed-action entitlement.
 *
 * One query answering both halves of the allowance question: which tier the
 * organisation is on, and how many governed actions its plan row includes per
 * entitlement year (ADR-052 §4.2, spec §7.3).
 *
 * It is one query on purpose. This sits on the accrual path, which runs after
 * every governed action, and `resolveOrgTier` plus a separate plan read would
 * be two round trips per action for two columns of the same join.
 */

import { and, eq, inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "./tier";
import { TIER_ACTION_ALLOWANCES } from "./action-metering";

const VALID_TIERS = new Set<PlanTier>(["free", "build", "scale", "enterprise"]);

function isTier(value: unknown): value is PlanTier {
  return typeof value === "string" && VALID_TIERS.has(value as PlanTier);
}

export interface OrgActionEntitlement {
  tier: PlanTier;
  /**
   * The organisation's recorded governed-action commitment: from
   * `billing.plans.included_actions_annual` when an entitled subscription
   * answered, otherwise from `org.organizations.negotiated_actions_annual` —
   * the legacy leg's place to record a figure for an enterprise organisation
   * that never went through Stripe checkout. Null means "fall back to the tier
   * default" — never "unlimited"; `resolveActionAllowance` enforces that
   * distinction.
   */
  includedActionsAnnual: number | null;
}

/**
 * Resolve an organisation's tier and stored action allowance together.
 *
 * The entitled-status list is shared with {@link ENTITLED_SUBSCRIPTION_STATUSES}
 * rather than restated. That list is the fix for #1384, where tier resolution
 * counted only `active` while every other subscription query in this package
 * counted a trial too — and because the tier gate switches IAM on, the
 * mismatch switched a security control off. A second copy here would be a
 * second chance to make the same mistake.
 *
 * Falls back to the legacy `organizations.plan_type` leg for pre-billing-table
 * organisations, exactly as `resolveOrgTierDetailed` does, so the two functions
 * cannot disagree about which tier an organisation is on.
 */
export async function resolveOrgActionEntitlement(
  orgId: string,
): Promise<OrgActionEntitlement> {
  // An empty orgId is a real case (`create_org` runs before an org exists) and
  // both columns are `uuid`, which Postgres cannot compare to "". Answer
  // without querying, on the most restricted tier.
  if (!orgId) return { tier: "free", includedActionsAnnual: null };

  const { sub, org } = await withSystemDb(async (tx) => {
    const s = await tx
      .select({
        tier: schema.plans.tier,
        includedActionsAnnual: schema.plans.includedActionsAnnual,
      })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.subscriptions.planId, schema.plans.id))
      .where(
        and(
          eq(schema.subscriptions.orgId, orgId),
          inArray(schema.subscriptions.status, [
            ...ENTITLED_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    const o = await tx
      .select({
        planType: schema.organizations.planType,
        // Selected from a row this query already reads, so the legacy leg costs
        // no extra round trip on the accrual path.
        negotiatedActionsAnnual: schema.organizations.negotiatedActionsAnnual,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    return { sub: s, org: o };
  });

  const row = sub[0];
  if (row && isTier(row.tier)) {
    return {
      tier: row.tier,
      includedActionsAnnual:
        row.includedActionsAnnual === null
          ? null
          : Number(row.includedActionsAnnual),
    };
  }

  const orgRow = org[0];
  if (isTier(orgRow?.planType)) {
    // `negotiated_actions_annual` is this leg's equivalent of the plan row's
    // `included_actions_annual`. Without it an enterprise organisation that
    // never went through Stripe checkout had NOWHERE to record its commitment,
    // so `resolveActionAllowance` fell to the scale figure and logged
    // `billing_enterprise_allowance_missing` on every governed action —
    // permanently, with no action an operator could take to clear it. NULL
    // still means "fall back to the tier default", never "unlimited".
    const negotiated = orgRow.negotiatedActionsAnnual;
    const parsed =
      negotiated === null || negotiated === undefined
        ? Number.NaN
        : Number(negotiated);
    return {
      tier: orgRow.planType,
      // A non-finite or negative figure is a corrupt row, not a smaller
      // commitment, and handing it on would put NaN into the allowance the
      // meter compares an action count against. The DB CHECK forbids negatives;
      // this is the belt to its braces, and it lands on the tier default —
      // which for enterprise is the bounded fallback plus its alert, so a
      // corrupt row under-bills visibly rather than running free.
      includedActionsAnnual:
        Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null,
    };
  }
  return { tier: "free", includedActionsAnnual: null };
}

/**
 * The published default allowance for a tier, with no DB read.
 *
 * For quotes and the rate-card capability, where the question is "what does
 * this tier include" rather than "what does this organisation have".
 */
export function publishedAllowanceForTier(tier: PlanTier): number | null {
  return TIER_ACTION_ALLOWANCES[tier];
}
