import { and, asc, eq, inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
// tenancy: unscoped seam (shared catalog — billing.plans is a platform-wide
// plan catalog with no per-tenant rows; no org/workspace filter applies;
// withSystemDb bypasses RLS deliberately)
import type { PlanRow } from "@oxagen/database";
import { SUBSCRIPTION_PLANS } from "@oxagen/billing";
import type { Plan } from "@/components/billing/plan-card";
import { safeQuery } from "./safe-query";

/**
 * Canonical, purchasable subscription-plan slugs. The SINGLE SOURCE OF TRUTH is
 * `SUBSCRIPTION_PLANS` in `@oxagen/billing` (build-v2 / scale-v2 / enterprise-v2);
 * the `billing.plans` table is a downstream mirror the stripe-sync script writes.
 *
 * The billing UI must render ONLY these tiers. `billing.plans` can accumulate
 * rows the grid must never show: the non-purchasable `free` tier (seeded), legacy
 * pre-`-v2` slugs from an earlier sync, and e2e-test plan rows. Each of those
 * carries `is_public = true` AND a real `tier`, so neither an `is_public` check
 * nor a `tier != 'free'` guard is sufficient — a stale `build` row passes both.
 * Pinning the read to the canonical slug allowlist is the only filter that keeps
 * the grid correct no matter what else is sitting in the table.
 */
const PUBLIC_PLAN_SLUGS = SUBSCRIPTION_PLANS.map((p) => p.slug);

/**
 * Fetch the subscription plans the billing UI is allowed to display — the
 * canonical paid tiers that are also flagged public — ordered cheapest-first for
 * a stable grid. Shared by the Subscription and Plans tabs so the dedupe/filter
 * lives in exactly one place. Degrades to an empty list on query failure.
 */
export const fetchPublicPlans = (): Promise<PlanRow[]> =>
  safeQuery(
    () =>
      withSystemDb((tx) =>
        tx
          .select()
          .from(schema.plans)
          .where(
            and(
              eq(schema.plans.isPublic, true),
              inArray(schema.plans.slug, PUBLIC_PLAN_SLUGS),
            ),
          )
          .orderBy(asc(schema.plans.monthlyCents)),
      ),
    [] as PlanRow[],
  );

/**
 * Build Plan[] from SUBSCRIPTION_PLANS constant as a local-dev fallback.
 * 1 credit = 1¢, so includedCreditCents = includedCredits.
 * publicId uses slug (unique, stable; only used as React key in PlansGrid).
 */
function plansFromConstant(): Plan[] {
  return SUBSCRIPTION_PLANS.map((p) => ({
    publicId: p.slug,
    slug: p.slug,
    name: p.displayName,
    tier: p.tier,
    monthlyCents: p.monthlyCents,
    annualCents: p.annualCents,
    includedCreditCents: p.includedCredits,
    includedSeats: p.seats,
    features: p.features.list.map((label) => ({ label })),
  }));
}

/**
 * Returns Plan[] for the billing grid. Uses DB rows when the stripe-sync has
 * been run (prod / staging); falls back to SUBSCRIPTION_PLANS when the table
 * is empty (local dev without stripe-sync). Always returns the three paid tiers.
 */
export async function fetchPlanCards(): Promise<Plan[]> {
  const rows = await fetchPublicPlans();
  if (rows.length > 0) return toPlanCards(rows);
  return plansFromConstant();
}

/**
 * Map `billing.plans` rows to the `PlanCard` prop shape — shared by both billing
 * tabs so the parsing lives in one place. The `features` jsonb is written by
 * stripe-sync from `SUBSCRIPTION_PLANS[].features` as `{ list: string[] }` (see
 * `@oxagen/billing` `PlanFeatures`). We defensively tolerate a missing or legacy
 * shape (older rows stored a structured dict with no `list` key) and fall back to
 * no bullets rather than throwing.
 */
export const toPlanCards = (rows: PlanRow[]): Plan[] =>
  rows.map((p) => ({
    publicId: p.publicId,
    slug: p.slug,
    name: p.name,
    tier: p.tier,
    monthlyCents: p.monthlyCents,
    annualCents: p.annualCents,
    includedCreditCents: p.includedCreditCents,
    includedSeats: p.includedSeats,
    features: Array.isArray((p.features as { list?: unknown[] } | null)?.list)
      ? ((p.features as { list: unknown[] }).list as string[]).map((label) => ({
          label,
        }))
      : [],
  }));
