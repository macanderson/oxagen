/**
 * resolveOrgTier — resolve an org's effective subscription tier.
 *
 * Resolution order (most-reliable first):
 *   1. An ENTITLED billing.subscriptions row → billing.plans.tier
 *   2. org.organizations.plan_type   (legacy fallback)
 *   3. 'free'                        (hard default)
 *
 * This is the single read path for plan-tier gating. Call it once per
 * request (the API/MCP middleware populates ctx.planTier via this function)
 * and thread the result through CapabilityContext.planTier.
 *
 * A lower tier is not only a smaller feature set: `checkIAM` bypasses the IAM
 * resolver entirely for any org that does not resolve to `enterprise`. So this
 * function decides whether a security control runs at all, and every way it can
 * under-report a tier is a way to switch that control off (#1384). Two
 * consequences are wired in below rather than left to the caller:
 * {@link ENTITLED_SUBSCRIPTION_STATUSES}, and {@link resolveOrgTierDetailed}
 * reporting whether the answer was established or defaulted to.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";

const VALID_TIERS = new Set<PlanTier>(["free", "build", "scale", "enterprise"]);

function isTier(value: unknown): value is PlanTier {
  return typeof value === "string" && VALID_TIERS.has(value as PlanTier);
}

/**
 * Subscription statuses that carry the plan's tier.
 *
 * This used to be `active` alone, and it was the outlier: every other
 * subscription query in this package counts a trial as entitled
 * (`checkout.ts`, `grants.ts`, `seats.ts` all read
 * `IN ('active','trialing')`, and `dunning.ts` adds `past_due`). An enterprise
 * org in trial therefore resolved to a non-enterprise tier, and because the
 * tier gate bypasses IAM below enterprise, every capability check for that org
 * returned allow without consulting a single policy (#1384).
 *
 * `past_due` and `paused` are here for the reason the issue gives: whether a
 * lapsing org keeps a FEATURE is a billing question, but losing a security
 * control must never be a consequence of a billing state. A missed payment
 * should stop new spend, not silently unenforce an enterprise org's access
 * policies.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "paused",
] as const;

/**
 * A tier answer plus whether it was ESTABLISHED or merely defaulted to.
 *
 * The distinction exists because `free` is both a real tier and the hard
 * default, and a security gate must be able to tell them apart: an org that is
 * genuinely on the free plan is a different fact from an org whose row is
 * missing entirely, and only the first is a reason to switch a control off.
 */
export interface TierResolution {
  tier: PlanTier;
  /** True when a subscription or an organization row actually said so. */
  established: boolean;
  source: "subscription" | "organization" | "absent-org" | "no-org-id";
}

/**
 * Resolve the effective plan tier for an org.
 *
 * Pure DB read — no Stripe calls, no side effects. Safe to call on every
 * request once. Falls back to 'free' if no active subscription exists so
 * un-subscribed orgs are always in the most restricted tier (fail-safe).
 */
export async function resolveOrgTierDetailed(
  orgId: string,
): Promise<TierResolution> {
  // An empty orgId is a real case: `create_org` is user-scoped and runs before
  // any org exists, so the IAM check calls this with "". Both columns below are
  // `uuid`, and Postgres cannot compare a uuid to "" — the query would raise
  // 22P02 (invalid input syntax for type uuid) rather than return no rows.
  //
  // So answer without querying. This is step 3 of the ladder above: an org with
  // no subscription resolves to 'free', and an org that does not exist yet can
  // have no more entitlement than that. 'free' is the most restricted tier, so
  // returning it here grants nothing.
  if (!orgId) return { tier: "free", established: true, source: "no-org-id" };

  const { entitledSub: activeSub, org } = await withSystemDb(async (tx) => {
    const sub = await tx
      .select({ tier: schema.plans.tier })
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
      .select({ planType: schema.organizations.planType })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);

    return { entitledSub: sub, org: o };
  });

  // 1. Active subscription → plan tier (the authoritative source).
  if (activeSub.length > 0) {
    const tier = activeSub[0]?.tier;
    if (isTier(tier))
      return { tier, established: true, source: "subscription" };
  }

  // 2. Legacy plan_type on the org row (covers pre-billing-tables orgs).
  if (org.length > 0) {
    const planType = org[0]?.planType;
    if (isTier(planType)) {
      return { tier: planType, established: true, source: "organization" };
    }
    // The org exists and simply carries no recognised plan: genuinely free.
    return { tier: "free", established: true, source: "organization" };
  }

  // 3. Hard default — unrecognised or missing.
  //
  // Reaching here with a real orgId means neither a subscription nor an
  // organization row answered: the org is not merely free, it is unaccounted
  // for. `free` is still returned so every existing caller behaves as before,
  // but `established: false` lets a security gate refuse to treat that as
  // permission.
  return { tier: "free", established: false, source: "absent-org" };
}

/**
 * Resolve the effective plan tier for an org — the answer only.
 *
 * Callers that gate a SECURITY control should use
 * {@link resolveOrgTierDetailed} instead and check `established`, because this
 * signature cannot distinguish "this org is on the free plan" from "nothing
 * told us anything about this org".
 */
export async function resolveOrgTier(orgId: string): Promise<PlanTier> {
  return (await resolveOrgTierDetailed(orgId)).tier;
}
