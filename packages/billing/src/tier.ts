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
import { withSystemDb, schema } from "@oxagen/database";
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
  // No org yet. `create_org` is user-scoped and runs before an org exists, so
  // checkIAM reaches here with an empty orgId — and both columns below are
  // `uuid`, which Postgres will not compare against ''. The query does not
  // return nothing, it raises 22P02 (invalid input syntax for type uuid), the
  // IAM check catches it and fails closed, and the user is told
  // `create_org` is forbidden. The symptom is that a brand-new account can
  // never create its first organization.
  //
  // Returning early is the documented step 3, not a new rule: an org with no
  // subscription row resolves to 'free', and an org that does not exist yet
  // has strictly less entitlement than that. 'free' is also the most
  // restricted tier, so this widens nothing — `canAccessACL('free')` is false,
  // which routes the caller into the non-enterprise bypass above.
  if (!orgId) return "free";

  const { activeSub, org } = await withSystemDb(async (tx) => {
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
