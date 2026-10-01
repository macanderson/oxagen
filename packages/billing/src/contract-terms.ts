/**
 * contract-terms.ts — the customer's contracted governed-action terms
 * (ADR-055 §3).
 *
 * One resolver with one fallback. The effective `billing.contract_terms` row
 * is the answer when the organisation has one; otherwise the published terms
 * on the `billing.plans` row of the organisation's entitled subscription; and
 * for an organisation with no entitled subscription, the Free plan's row.
 * Nothing copies terms into the organisation, so a change on either table is
 * reflected on the next read and the next bucket.
 *
 * `organizations.plan_type` is not read here. `create_org` only ever writes
 * `free` there, so a leg through that column would answer for one class of
 * row only; `resolveOrgTier` keeps its own leg because it answers a different
 * question (the IAM tier gate).
 *
 * The subscription's period is resolved in the same round trip because the
 * two readers of the terms — the gate and the recorder — also need it, for
 * `periodFor` (gau-bucket.ts). Two queries per governed action for two rows
 * of the same join would be one too many.
 */

import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import type { GauTerms } from "./pricing";
import type { SignupGrant } from "./signup-grant";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "./tier";

/** The seeded Free plan (`packages/database/src/seed.ts`, `PLAN_SEEDS`). */
export const FREE_PLAN_SLUG = "free";

const VALID_TIERS = new Set<PlanTier>(["free", "build", "scale", "enterprise"]);

function isTier(value: unknown): value is PlanTier {
  return typeof value === "string" && VALID_TIERS.has(value as PlanTier);
}

export type ContractTerms =
  | ({
      source: "negotiated";
      /** The entitlement's tier — the negotiated row carries none. */
      tier: PlanTier;
      agreementRef: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
    } & GauTerms)
  | ({
      source: "published_tier";
      tier: PlanTier;
      /**
       * When the published figures took effect: the plan row's `updated_at`.
       * `billing.plans` carries no effective window of its own, and the one
       * instant on the row that a rate change moves is the audit column the
       * writer (`pnpm billing:stripe-sync`, or the seed) stamps.
       */
      effectiveFrom: Date;
      /** Published terms are open-ended; only a negotiated row ends. */
      effectiveTo: null;
    } & GauTerms);

/** The subscription fields `periodFor` slices a month out of. */
export interface GauSubscriptionPeriod {
  billingInterval: "month" | "year";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export interface GauEntitlement {
  terms: ContractTerms;
  /** The entitled subscription, or null for an organisation with none. */
  subscription: GauSubscriptionPeriod | null;
  /**
   * The organisation's one-time signup grant (signup-grant.ts), or null for
   * an organisation that has none: one created before the grant existed and
   * not yet given one by the migration that introduced it.
   */
  grant: SignupGrant | null;
  /**
   * The Free row's `subscription_required_after_grant`: whether an
   * organisation with no subscription is refused once its grant is spent or
   * expired. When an operator clears it, such an organisation falls back to
   * the Free row's monthly allowance instead (ADR-241, signup grant).
   */
  subscriptionRequiredAfterGrant: boolean;
}

interface PlanTermsRow {
  tier: string;
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  updatedAt: Date;
}

function termsOf(row: {
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
}): GauTerms {
  return {
    currency: row.currency,
    ratePerGauMicros: BigInt(row.ratePerGauMicros),
    blockSizeGau: Number(row.blockSizeGau),
    includedGauPerMonth: Number(row.includedGauPerMonth),
  };
}

/**
 * The organisation's effective terms and its entitled subscription, read on
 * the caller's executor. The gate and the recorder pass a tenant-scoped
 * transaction through {@link resolveGauEntitlement}; the webhook grant, which
 * runs with no tenant scope, passes its `withSystemDb` transaction.
 */
export async function readGauEntitlement(
  tx: Tx,
  orgId: string,
  now: Date = new Date(),
): Promise<GauEntitlement> {
  const [n, e, f, g] = await Promise.all([
    // Effective: started, and not yet ended. The partial unique index on
    // (org_id) WHERE effective_to IS NULL keeps one open row per org; a row
    // with a future effective_to is still in force until that instant.
    tx
      .select({
        agreementRef: schema.contractTerms.agreementRef,
        currency: schema.contractTerms.currency,
        ratePerGauMicros: schema.contractTerms.ratePerGauMicros,
        blockSizeGau: schema.contractTerms.blockSizeGau,
        includedGauPerMonth: schema.contractTerms.includedGauPerMonth,
        effectiveFrom: schema.contractTerms.effectiveFrom,
        effectiveTo: schema.contractTerms.effectiveTo,
      })
      .from(schema.contractTerms)
      .where(
        and(
          eq(schema.contractTerms.orgId, orgId),
          lte(schema.contractTerms.effectiveFrom, now),
          or(
            isNull(schema.contractTerms.effectiveTo),
            gt(schema.contractTerms.effectiveTo, now),
          ),
        ),
      )
      .orderBy(desc(schema.contractTerms.effectiveFrom))
      .limit(1),
    // The entitled subscription and its plan: the join plan-allowance.ts
    // makes, with the entitled-status list shared rather than restated
    // (#1384: two copies of that list once disagreed and switched a
    // security control off).
    tx
      .select({
        tier: schema.plans.tier,
        currency: schema.plans.currency,
        ratePerGauMicros: schema.plans.ratePerGauMicros,
        blockSizeGau: schema.plans.blockSizeGau,
        includedGauPerMonth: schema.plans.includedGauPerMonth,
        updatedAt: schema.plans.updatedAt,
        billingInterval: schema.subscriptions.billingInterval,
        currentPeriodStart: schema.subscriptions.currentPeriodStart,
        currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
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
      .limit(1),
    tx
      .select({
        tier: schema.plans.tier,
        currency: schema.plans.currency,
        ratePerGauMicros: schema.plans.ratePerGauMicros,
        blockSizeGau: schema.plans.blockSizeGau,
        includedGauPerMonth: schema.plans.includedGauPerMonth,
        updatedAt: schema.plans.updatedAt,
        subscriptionRequiredAfterGrant:
          schema.plans.subscriptionRequiredAfterGrant,
      })
      .from(schema.plans)
      .where(eq(schema.plans.slug, FREE_PLAN_SLUG))
      .limit(1),
    tx
      .select({
        grantedGau: schema.gauSignupGrants.grantedGau,
        grantedAt: schema.gauSignupGrants.grantedAt,
        expiresAt: schema.gauSignupGrants.expiresAt,
      })
      .from(schema.gauSignupGrants)
      .where(eq(schema.gauSignupGrants.orgId, orgId))
      .limit(1),
  ]);
  const negotiated = n[0];
  const entitled = e[0];
  const free = f[0];
  const grantRow = g[0];
  const grant: SignupGrant | null = grantRow
    ? { ...grantRow, grantedGau: Number(grantRow.grantedGau) }
    : null;
  // The rule is the Free row's. A database without that row fails below.
  const subscriptionRequiredAfterGrant =
    free?.subscriptionRequiredAfterGrant ?? true;

  const subscription: GauSubscriptionPeriod | null = entitled
    ? {
        billingInterval: entitled.billingInterval === "year" ? "year" : "month",
        currentPeriodStart: entitled.currentPeriodStart,
        currentPeriodEnd: entitled.currentPeriodEnd,
      }
    : null;

  const published: PlanTermsRow | undefined =
    entitled && isTier(entitled.tier) ? entitled : free;
  if (!published) {
    // The Free plan is written by `pnpm db:migrate` (seedPlatform). A database
    // without it has no published terms to fall back to, and a gate that
    // guessed a rate would bill at a figure nobody published.
    throw new Error(
      "billing: no published terms — the Free plan row is not seeded",
    );
  }
  const tier: PlanTier = isTier(published.tier) ? published.tier : "free";

  if (negotiated) {
    return {
      terms: {
        source: "negotiated",
        tier,
        agreementRef: negotiated.agreementRef,
        effectiveFrom: negotiated.effectiveFrom,
        effectiveTo: negotiated.effectiveTo,
        ...termsOf(negotiated),
      },
      subscription,
      grant,
      subscriptionRequiredAfterGrant,
    };
  }
  return {
    terms: {
      source: "published_tier",
      tier,
      effectiveFrom: published.updatedAt,
      effectiveTo: null,
      ...termsOf(published),
    },
    subscription,
    grant,
    subscriptionRequiredAfterGrant,
  };
}

/**
 * Statuses of a subscription that once entitled the organisation and has
 * since lapsed. An `incomplete` or `incomplete_expired` row never took a
 * first payment, so it entitled nobody.
 */
const LAPSED_SUBSCRIPTION_STATUSES = ["canceled", "unpaid"] as const;

/**
 * Whether a subscription covered the bucket over `period`, read from the
 * stored subscription rows on the caller's executor (ADR-241, signup grant).
 *
 * The close job reads this after the bucket has ended. By then a
 * subscription canceled at its period end reads `canceled`, and
 * `readGauEntitlement` leaves it out, so today's entitlement would call the
 * ended bucket a non-subscriber's and drop its overage. A row counts when it
 * existed before the bucket ended and either is still entitled (a renewal
 * moved its period past the bucket) or lapsed with a recorded period that
 * overlaps the bucket and runs to its end.
 */
export async function readPeriodSubscribed(
  tx: Tx,
  orgId: string,
  period: { start: Date; end: Date },
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.orgId, orgId),
        lt(schema.subscriptions.createdAt, period.end),
        or(
          inArray(schema.subscriptions.status, [
            ...ENTITLED_SUBSCRIPTION_STATUSES,
          ]),
          and(
            inArray(schema.subscriptions.status, [
              ...LAPSED_SUBSCRIPTION_STATUSES,
            ]),
            lt(schema.subscriptions.currentPeriodStart, period.end),
            gte(schema.subscriptions.currentPeriodEnd, period.end),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The organisation's effective terms and its entitled subscription, in one
 * tenant-scoped round trip. Runs inside the caller's tenant scope: the kernel
 * enters it before the gate and re-enters it for the recorder.
 */
export async function resolveGauEntitlement(
  orgId: string,
  now: Date = new Date(),
): Promise<GauEntitlement> {
  return withTenantDb((tx) => readGauEntitlement(tx, orgId, now));
}

/**
 * The organisation's effective contracted terms: the negotiated row when one
 * is in force at `now`, otherwise the published figures of its entitled
 * plan, otherwise the Free plan's (ADR-055 §3).
 */
export async function resolveContractTerms(
  orgId: string,
  now: Date = new Date(),
): Promise<ContractTerms> {
  return (await resolveGauEntitlement(orgId, now)).terms;
}
