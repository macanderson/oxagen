/**
 * resolveOrgTier — resolve an org's effective subscription tier.
 *
 * Resolution order (most-reliable first):
 *   1. Active billing.subscriptions → billing.plans.tier
 *   2. org.organizations.plan_type   (legacy fallback)
 *   3. 'free'                        (hard default)
 *
 * This is the single read path for plan-tier gating. Call it once per
 * request (the API/MCP middleware populates ctx.planTier via this function)
 * and thread the result through CapabilityContext.planTier.
 */
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";

const VALID_TIERS = new Set<PlanTier>(["free", "build", "scale", "enterprise"]);

function isTier(value: unknown): value is PlanTier {
  return typeof value === "string" && VALID_TIERS.has(value as PlanTier);
}

/**
 * Resolve the effective plan tier for an org.
 *
 * Pure DB read — no Stripe calls, no side effects. Safe to call on every
 * request once. Falls back to 'free' if no active subscription exists so
 * un-subscribed orgs are always in the most restricted tier (fail-safe).
 */
export async function resolveOrgTier(orgId: string): Promise<PlanTier> {
  const { activeSub, org } = await withTenantDb(async (tx) => {
    const sub = await tx
      .select({ tier: schema.plans.tier })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.subscriptions.planId, schema.plans.id))
      .where(
        and(
          eq(schema.subscriptions.orgId, orgId),
          eq(schema.subscriptions.status, "active"),
        ),
      )
      .limit(1);

    const o = await tx
      .select({ planType: schema.organizations.planType })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);

    return { activeSub: sub, org: o };
  });

  // 1. Active subscription → plan tier (the authoritative source).
  if (activeSub.length > 0) {
    const tier = activeSub[0]?.tier;
    if (isTier(tier)) return tier;
  }

  // 2. Legacy plan_type on the org row (covers pre-billing-tables orgs).
  if (org.length > 0) {
    const planType = org[0]?.planType;
    if (isTier(planType)) return planType;
  }

  // 3. Hard default — unrecognised or missing → treat as free.
  return "free";
}
