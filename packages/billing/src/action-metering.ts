/**
 * action-metering.ts — the governed action as the billable unit (ADR-052,
 * refined by ADR-055).
 *
 * The charging path. `metering.ts` keeps the token meter, which under ADR-052
 * §4.4 is a REPORT: it prices a call in full and bills it at zero, except for
 * the one case ADR-053 §3 carves out (tokens the platform key paid for). This
 * file is what actually accrues.
 *
 * The shape of the meter, in one paragraph. Every top-level `invoke()` that
 * passes its gates, runs its handler and validates its output is one governed
 * action. Actions debit the organisation's month bucket of governed action
 * units (`billing.gau_buckets`, gau-bucket.ts): the month's included units
 * come from the customer's contracted terms (contract-terms.ts), bought units
 * arrive through Checkout or auto top-up, and unused bought units carry into
 * the next month. Past the bucket a prepaid organisation is topped up from
 * its saved card or refused by the gate; an invoice-billed organisation is
 * never capped and is invoiced for its overage. Nothing about the charge
 * depends on how long a run took or how many tokens it spent, because under
 * ADR-043 nothing in this repo costs more for either.
 *
 * The rate card and the annual allowances below are what the rate-card,
 * estimate and usage capabilities publish; the recorder prices nothing by
 * them. Rates: docs/specs/governed-action-metering.md §4.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import { readOrgBillingSettings } from "./billing-settings";
import { resolveGauEntitlement } from "./contract-terms";
import {
  ensureCurrentBucket,
  periodFor,
  remainingGau,
  type GauBucketRow,
} from "./gau-bucket";
import { claimAutoTopup, type GauSettlementRow } from "./gau-settlements";
import { readDefaultPaymentMethod } from "./payment-methods";
import { CREDIT_VALUE_USD } from "./pricing";
import { logger } from "./logger";

// ── The rate card (spec §4.1) ───────────────────────────────────────────────

/**
 * One volume band: a price per 1,000 governed actions, selected by the
 * organisation's ANNUAL action total.
 *
 * `maxAnnualActions` is exclusive and `null` on the last band, so the bands
 * tile the whole number line with no gap and no overlap —
 * {@link resolveActionBand} can therefore never fail to find one, and the
 * "no band matched" branch that a half-open table would need does not exist.
 */
export interface ActionRateBand {
  /** Inclusive lower bound of the band, in annual governed actions. */
  minAnnualActions: number;
  /** Exclusive upper bound, or null for the top band. */
  maxAnnualActions: number | null;
  /** USD per 1,000 governed actions. */
  usdPer1000: number;
  /** Stable identifier for the band — safe to show a customer and to log. */
  id: "first-1m" | "1m-5m" | "5m-25m" | "committed-25m-plus";
}

/**
 * Spec §4.1, v1 rates set 2026-09-14. A customer's whole volume prices at the
 * band their annual total lands in, so the bands are read against a running
 * annual figure rather than applied marginally. The first band is the list
 * rate every published tier carries (5,000 micros per GAU).
 */
export const ACTION_RATE_BANDS: readonly ActionRateBand[] = [
  {
    id: "first-1m",
    minAnnualActions: 0,
    maxAnnualActions: 1_000_000,
    usdPer1000: 5,
  },
  {
    id: "1m-5m",
    minAnnualActions: 1_000_000,
    maxAnnualActions: 5_000_000,
    usdPer1000: 4,
  },
  {
    id: "5m-25m",
    minAnnualActions: 5_000_000,
    maxAnnualActions: 25_000_000,
    usdPer1000: 3,
  },
  {
    id: "committed-25m-plus",
    minAnnualActions: 25_000_000,
    maxAnnualActions: null,
    usdPer1000: 2,
  },
] as const;

/**
 * The band an annual action total falls in. Total volume, not marginal — a
 * customer at 3M actions prices every one of them at the 1M–5M rate.
 *
 * A negative or non-finite total resolves to the first band rather than
 * throwing: this sits on the accrual path, and refusing to price an action
 * because a counter read badly would bill it at zero, which is the worse of
 * the two errors.
 */
export function resolveActionBand(annualActions: number): ActionRateBand {
  const total =
    Number.isFinite(annualActions) && annualActions > 0 ? annualActions : 0;
  for (const band of ACTION_RATE_BANDS) {
    if (
      total >= band.minAnnualActions &&
      (band.maxAnnualActions === null || total < band.maxAnnualActions)
    ) {
      return band;
    }
  }
  // Unreachable: the bands tile [0, ∞). Kept so a future edit that opens a gap
  // fails loudly at the last band rather than returning undefined.
  /* c8 ignore next */
  return ACTION_RATE_BANDS[ACTION_RATE_BANDS.length - 1] as ActionRateBand;
}

// ── Tier allowances (spec §4.2) ─────────────────────────────────────────────

/**
 * Included governed actions per entitlement year, by subscription tier.
 *
 * These are the DEFAULTS. The authoritative figure is
 * `billing.plans.included_actions_annual` on the organisation's own plan row,
 * which is what a negotiated enterprise commitment writes to. This table is
 * what an organisation with no plan row falls back to, and what the rate-card
 * capability publishes.
 *
 * Enterprise is `null` — negotiated (spec §7.3). `null` means "read the plan
 * row", NOT "unlimited"; {@link resolveActionAllowance} refuses to treat a
 * missing enterprise figure as unlimited.
 */
export const TIER_ACTION_ALLOWANCES: Readonly<Record<PlanTier, number | null>> =
  {
    free: 25_000,
    build: 250_000,
    scale: 1_500_000,
    enterprise: null,
  };

/**
 * The allowance a mis-provisioned enterprise plan falls back to.
 *
 * Spec §7.3: "negotiated" used to mean absent in code, and an absent allowance
 * is indistinguishable from an unlimited one. An enterprise organisation whose
 * committed figure was never written should under-bill by a bounded amount, not
 * run free — so it lands on the `scale` allowance and the fallback is logged.
 */
export const ENTERPRISE_FALLBACK_ALLOWANCE = 1_500_000;

/**
 * Included actions for a tier, given the plan row's stored figure if there is
 * one. `planIncluded` comes from `billing.plans.included_actions_annual`.
 */
export function resolveActionAllowance(
  tier: PlanTier,
  planIncluded?: number | null,
): number {
  if (
    planIncluded !== undefined &&
    planIncluded !== null &&
    Number.isFinite(planIncluded) &&
    planIncluded >= 0
  ) {
    return Math.floor(planIncluded);
  }
  const fromTier = TIER_ACTION_ALLOWANCES[tier];
  if (fromTier !== null) return fromTier;
  logger.warn(
    { tier, alert: "billing_enterprise_allowance_missing" },
    "billing: enterprise plan carries no included_actions_annual; falling back to the scale allowance rather than treating it as unlimited",
  );
  return ENTERPRISE_FALLBACK_ALLOWANCE;
}

// ── Retention (spec §4.3) ───────────────────────────────────────────────────

/** Evidence retention included on every paid tier, in months. */
export const RETENTION_INCLUDED_MONTHS = 12;

/** USD per GB-month for evidence held beyond {@link RETENTION_INCLUDED_MONTHS}. */
export const RETENTION_USD_PER_GB_MONTH = 0.08;

// ── Pricing actions (spec §4.1) ─────────────────────────────────────────────

/**
 * What `count` governed actions are worth in whole credits at `band` — the
 * DISPLAY figure (a quote, a usage readout), rounded up. Published by the
 * rate-card and usage capabilities; the recorder charges nothing by it.
 */
export function creditsForActions(
  count: number,
  band: ActionRateBand = ACTION_RATE_BANDS[0] as ActionRateBand,
): bigint {
  if (!Number.isFinite(count) || count <= 0) return 0n;
  const credits = (count * band.usdPer1000) / 1000 / CREDIT_VALUE_USD;
  return credits <= 0 ? 0n : BigInt(Math.ceil(credits));
}

/**
 * What a whole annual volume costs, priced at the single band the total lands
 * in — the §4.1 rule as written, in whole credits. A report figure:
 * `get_action_usage` prints it beside the annual counter until WL-27 retires
 * both with the dollar model they describe.
 */
export function priceAnnualVolumeCredits(annualActions: number): bigint {
  return creditsForActions(annualActions, resolveActionBand(annualActions));
}

// ── The entitlement period ──────────────────────────────────────────────────

/**
 * First instant of the entitlement year containing `now`, UTC.
 *
 * The calendar year, because both the allowances (§4.2) and the volume bands
 * (§4.1) are annual and a calendar year needs no per-org state to compute. An
 * organisation on an annual contract with a different anniversary reconciles at
 * contract term (§6 step 5); the meter's own window does not have to match it
 * for the count to be right.
 */
export function actionPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

// ── The counter ─────────────────────────────────────────────────────────────

export interface ActionCounterState {
  /** Actions taken in the period BEFORE this increment. */
  before: number;
  /** Actions taken in the period INCLUDING this increment. */
  after: number;
}

/**
 * Add `actions` to the organisation's counter for the current period and return
 * the totals either side of the increment.
 *
 * One statement. The upsert takes the row lock, so a concurrent action for the
 * same organisation blocks and reads the post-write total rather than racing
 * it — which is what makes the allowance boundary exact under concurrency
 * instead of letting two calls both see themselves as the last free one.
 *
 * Reads through `withTenantDb`, so the caller must be inside a tenant scope.
 */
export async function incrementActionCounter(
  orgId: string,
  actions: number,
  chargedActions: number,
  now: Date = new Date(),
): Promise<ActionCounterState> {
  const periodStart = actionPeriodStart(now);
  const delta = BigInt(Math.max(0, Math.floor(actions)));
  const chargedDelta = BigInt(Math.max(0, Math.floor(chargedActions)));

  const rows = await withTenantDb((tx) =>
    tx
      .insert(schema.governedActionCounters)
      .values({
        orgId,
        periodStart,
        actionsUsed: delta,
        actionsCharged: chargedDelta,
      })
      .onConflictDoUpdate({
        target: [
          schema.governedActionCounters.orgId,
          schema.governedActionCounters.periodStart,
        ],
        set: {
          actionsUsed: sql`${schema.governedActionCounters.actionsUsed} + ${delta}`,
          actionsCharged: sql`${schema.governedActionCounters.actionsCharged} + ${chargedDelta}`,
          updatedAt: new Date(),
        },
      })
      .returning({ actionsUsed: schema.governedActionCounters.actionsUsed }),
  );

  const after = Number(rows[0]?.actionsUsed ?? delta);
  return { before: after - Number(delta), after };
}

/** Read the counter without changing it. Returns zeroes when no row exists. */
export async function readActionCounter(
  orgId: string,
  now: Date = new Date(),
): Promise<{ periodStart: Date; actionsUsed: number; actionsCharged: number }> {
  const periodStart = actionPeriodStart(now);
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        actionsUsed: schema.governedActionCounters.actionsUsed,
        actionsCharged: schema.governedActionCounters.actionsCharged,
      })
      .from(schema.governedActionCounters)
      .where(
        and(
          eq(schema.governedActionCounters.orgId, orgId),
          eq(schema.governedActionCounters.periodStart, periodStart),
        ),
      )
      .limit(1),
  );
  return {
    periodStart,
    actionsUsed: Number(rows[0]?.actionsUsed ?? 0n),
    actionsCharged: Number(rows[0]?.actionsCharged ?? 0n),
  };
}

// ── The recorder ────────────────────────────────────────────────────────────

export interface RecordActionArgs {
  orgId: string;
  /** Governed actions this invocation is worth. Always >= 1 from the kernel. */
  actions: number;
  /** Canonical capability name — logged. */
  capability: string;
  /** The run this action belongs to. Metadata only, never a billing unit. */
  runId?: string | null;
  now?: Date;
}

export interface RecordActionResult {
  /** The organisation's month bucket after this action landed. */
  bucket: GauBucketRow;
  /** `included + purchased + carried − used` after the debit; negative when overdrawn. */
  remainingGau: number;
  /** The organisation's billing mode at the time of the debit. */
  mode: "prepaid" | "invoice";
  /** The auto top-up episode this action claimed, or null when none was. */
  autoTopup: GauSettlementRow | null;
}

/**
 * Record one governed action (or a batch of them, for a contract that declares
 * a `meter` block) against the organisation's month bucket
 * (ARCHITECTURE.md §3.9 item 8).
 *
 *   a. Resolve the terms, the settings and the period.
 *   b. Debit: `ensureCurrentBucket(tx, …)` — the lazy create and the debit as
 *      one upsert in its own transaction, so the count lands whatever happens
 *      after it. The returned row is the input to c.
 *   c. Prepaid, at `remaining ≤ 0`, with auto top-up on and a saved default
 *      card: claim at most one auto top-up episode (`claimAutoTopup`, its own
 *      transaction, committed before any provider call). A Free organisation
 *      with no card claims nothing — the gate refuses its next action with
 *      `reason: "free_no_payment_method"` until it saves one or the next month
 *      opens (ADR-055 §6). The settlement sequence that turns the claim into a
 *      Stripe invoice is WL-31.
 *
 * Runs inside the tenant scope the kernel re-entered for it. The kernel calls
 * it once per completed top-level governed invocation and catches anything it
 * throws, so the debit runs exactly once per invocation; everything after the
 * debit is caught here so a claim that fails cannot surface as a broken
 * request whose work is already done.
 */
export async function recordGovernedAction(
  args: RecordActionArgs,
): Promise<RecordActionResult> {
  const start = Date.now();
  const actions = Math.max(1, Math.floor(args.actions));
  const now = args.now ?? new Date();

  // a. Resolve.
  const [{ terms, subscription }, settings] = await Promise.all([
    resolveGauEntitlement(args.orgId, now),
    readOrgBillingSettings(args.orgId),
  ]);
  const mode: RecordActionResult["mode"] = settings.approvedForInvoiceBilling
    ? "invoice"
    : "prepaid";
  const period = periodFor(subscription, now);

  // b. Debit, one statement.
  const bucket = await withTenantDb((tx) =>
    ensureCurrentBucket(tx, args.orgId, {
      period,
      terms,
      usedDelta: actions,
      purchasedDelta: 0,
    }),
  );
  const remaining = remainingGau(bucket);

  let autoTopup: GauSettlementRow | null = null;
  try {
    // The annual counter `get_action_usage` reports until WL-27 retires both.
    await incrementActionCounter(args.orgId, actions, 0, now);

    // c. Prepaid: at most one auto top-up episode at a time.
    if (mode === "prepaid" && remaining <= 0 && settings.autoTopupEnabled) {
      const card = await readDefaultPaymentMethod(args.orgId);
      if (card !== null) {
        autoTopup = await withTenantDb((tx) =>
          claimAutoTopup(tx, bucket, terms, settings.autoTopupBlocks),
        );
      }
    }
  } catch (error) {
    logger.error(
      {
        orgId: args.orgId,
        capability: args.capability,
        actions,
        bucketId: bucket.id,
        remainingGau: remaining,
        mode,
        err: error instanceof Error ? error.message : String(error),
      },
      "billing: governed action debited; the step after the debit failed",
    );
  }

  logger.info(
    {
      orgId: args.orgId,
      capability: args.capability,
      actions,
      bucketId: bucket.id,
      periodStart: period.start.toISOString(),
      includedGau: bucket.includedGau,
      purchasedGau: bucket.purchasedGau,
      carriedGau: bucket.carriedGau,
      usedGau: bucket.usedGau,
      remainingGau: remaining,
      mode,
      tier: terms.tier,
      termsSource: terms.source,
      autoTopupSettlementId: autoTopup?.id ?? null,
      runId: args.runId ?? null,
      durationMs: Date.now() - start,
    },
    "billing: governed action recorded",
  );

  return { bucket, remainingGau: remaining, mode, autoTopup };
}
