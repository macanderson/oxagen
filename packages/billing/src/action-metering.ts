/**
 * action-metering.ts — the governed action as the billable unit (ADR-052).
 *
 * The charging path. `metering.ts` keeps the token meter, which under ADR-052
 * §4.4 is a REPORT: it prices a call in full and bills it at zero, except for
 * the one case ADR-053 §3 carves out (tokens the platform key paid for). This
 * file is what actually accrues.
 *
 * The shape of the meter, in one paragraph. Every top-level `invoke()` that
 * passes its gates, runs its handler and validates its output is one governed
 * action. Actions accrue against an annual allowance carried by the
 * organisation's plan; past the allowance they price at the volume band the
 * organisation's running annual total lands in. Nothing about the price depends
 * on how long a run took or how many tokens it spent, because under ADR-043
 * nothing in this repo costs more for either.
 *
 * Rates: docs/specs/governed-action-metering.md §4. They are expected to move —
 * that is why they are here rather than in the ADR.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import { consumeCredits } from "./credits";
import { CREDIT_REASONS } from "./constants";
import { CREDIT_VALUE_USD, MICRO_CREDITS_PER_CREDIT } from "./pricing";
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
 * Spec §4.1. A customer's whole volume prices at the band their annual total
 * lands in, so the bands are read against a running annual figure rather than
 * applied marginally.
 */
export const ACTION_RATE_BANDS: readonly ActionRateBand[] = [
  {
    id: "first-1m",
    minAnnualActions: 0,
    maxAnnualActions: 1_000_000,
    usdPer1000: 20,
  },
  {
    id: "1m-5m",
    minAnnualActions: 1_000_000,
    maxAnnualActions: 5_000_000,
    usdPer1000: 15,
  },
  {
    id: "5m-25m",
    minAnnualActions: 5_000_000,
    maxAnnualActions: 25_000_000,
    usdPer1000: 10,
  },
  {
    id: "committed-25m-plus",
    minAnnualActions: 25_000_000,
    maxAnnualActions: null,
    usdPer1000: 6,
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

/**
 * Credits owed for a month of extended evidence retention, rounded UP to the
 * ledger's whole-credit unit.
 *
 * Rounding up is safe here in a way it is not on the token meter (#1413): this
 * charge is raised once a month against a whole organisation's stored volume,
 * not once per call, so there is no sequence of sub-credit charges for the
 * rounding to compound over.
 */
export function retentionCreditsForGbMonths(gbMonths: number): bigint {
  if (!Number.isFinite(gbMonths) || gbMonths <= 0) return 0n;
  const usd = gbMonths * RETENTION_USD_PER_GB_MONTH;
  return BigInt(Math.ceil(usd / CREDIT_VALUE_USD));
}

// ── Pricing actions (spec §4.1) ─────────────────────────────────────────────

/**
 * What `count` governed actions are worth in MICRO-credits at `band`.
 *
 * Micro-credits, not credits, for the same reason the token meter uses them: at
 * the $6 band one action is worth 0.6 of a credit, and rounding each one up to
 * a whole credit would over-charge a high-volume customer by 66% — the exact
 * failure #1413 fixed on the other meter. {@link consumeCredits} carries the
 * sub-credit remainder across calls, so a sequence of actions is exact.
 */
export function microCreditsForActions(
  count: number,
  band: ActionRateBand,
): bigint {
  if (!Number.isFinite(count) || count <= 0) return 0n;
  const usd = (count * band.usdPer1000) / 1000;
  const micros = (usd / CREDIT_VALUE_USD) * Number(MICRO_CREDITS_PER_CREDIT);
  return micros <= 0 ? 0n : BigInt(Math.round(micros));
}

/**
 * What `count` governed actions are worth in whole credits at `band` — the
 * DISPLAY figure (a quote, a usage readout), rounded up.
 *
 * An upper bound, not the debit. {@link microCreditsForActions} is what is
 * charged, and for a small count it is smaller than this. The two agree once a
 * count is worth a whole credit or more.
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
 * in — the §4.1 rule as written, in whole credits.
 *
 * The recorder charges INCREMENTALLY at whatever band the running total was in
 * at the time, which is not the same number: an organisation that ends the year
 * at 3M actions paid the $20 rate on its first million and the $15 rate after,
 * where §4.1 prices all 3M at $15. The difference is a true-up owed to the
 * customer, and it is surfaced rather than absorbed — `get_action_usage`
 * reports both figures so the amount is visible before the reconciliation, not
 * discovered after it.
 */
export function priceAnnualVolumeCredits(annualActions: number): bigint {
  return creditsForActions(annualActions, resolveActionBand(annualActions));
}

// ── Meter mode (spec §7.5) ──────────────────────────────────────────────────

export type ActionMeterMode = "shadow" | "charge";

// Env is fixed for a process lifetime and this is on the accrual hot path.
let _resolvedMode: ActionMeterMode | null = null;

/**
 * Whether the action meter charges or only counts.
 *
 * `shadow` records actions against the counter and raises no debit — spec §6
 * step 1, for a staged rollout. It defaults to `charge` because the interval
 * between `@oxagen/ai` giving up its markup and the action meter taking over is
 * an interval in which the platform bills nothing at all, and that is worse
 * than either end state (spec §7.5).
 */
export function resolveActionMeterMode(): ActionMeterMode {
  if (_resolvedMode !== null) return _resolvedMode;
  _resolvedMode =
    process.env.OXAGEN_ACTION_METER_MODE === "shadow" ? "shadow" : "charge";
  return _resolvedMode;
}

/** Reset the memoised mode. Tests only. */
export function resetActionMeterModeForTests(): void {
  _resolvedMode = null;
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

// ── Allowance arithmetic ────────────────────────────────────────────────────

/**
 * How many of the actions in `[before, after)` fall PAST the allowance.
 *
 * Written as the difference of two clamps rather than a branch, so the call
 * that straddles the allowance boundary — three actions where only one is
 * free — is the same expression as the calls either side of it, and cannot be
 * the case that got the branch wrong.
 */
export function billableActionCount(
  before: number,
  after: number,
  allowance: number,
): number {
  const overBefore = Math.max(0, before - allowance);
  const overAfter = Math.max(0, after - allowance);
  return Math.max(0, overAfter - overBefore);
}

// ── The recorder ────────────────────────────────────────────────────────────

export interface RecordActionArgs {
  orgId: string;
  /** Governed actions this invocation is worth. Always >= 1 from the kernel. */
  actions: number;
  /** Canonical capability name — logged, and the ledger's reference. */
  capability: string;
  /** The org's effective tier, if the caller already resolved it. */
  tier?: PlanTier;
  /** `billing.plans.included_actions_annual`, if the caller already read it. */
  planIncludedActions?: number | null;
  /** The run this action belongs to. Metadata only, never a billing unit. */
  runId?: string | null;
  now?: Date;
}

export interface RecordActionResult {
  /** Actions in the org's period after this one landed. */
  periodActions: number;
  /** Of this invocation's actions, how many priced as overage. */
  billableActions: number;
  /** The band the charge priced at. */
  band: ActionRateBand;
  /** Credits actually debited. Zero in shadow mode and inside the allowance. */
  creditsCharged: bigint;
  /** Credits the balance could not cover. */
  shortfallCredits: bigint;
  /** Whether the meter charged or only counted. */
  mode: ActionMeterMode;
}

/**
 * Record one governed action (or a batch of them, for a contract that declares
 * a `meter` block) and charge for whatever part of it falls past the
 * organisation's allowance.
 *
 * Order matters. The counter is incremented FIRST and the debit is raised
 * second, because the counter is what makes the allowance boundary exact under
 * concurrency, and a debit that fails must not also lose the count. The
 * consequence — a counted action whose debit failed — is the right way round:
 * it under-bills by one action and is visible in the counter as the gap between
 * `actions_used` and `actions_charged`, where a lost count would be invisible.
 *
 * Never throws on a billing failure. The kernel calls this after the action has
 * already happened and the customer's response is already correct; a throw here
 * could only turn a missed charge into a broken request.
 *
 * Reads through `withTenantDb`, so the caller must be inside a tenant scope.
 */
export async function recordGovernedAction(
  args: RecordActionArgs,
): Promise<RecordActionResult> {
  const start = Date.now();
  const mode = resolveActionMeterMode();
  const actions = Math.max(1, Math.floor(args.actions));
  const allowance = resolveActionAllowance(
    args.tier ?? "free",
    args.planIncludedActions,
  );
  const now = args.now ?? new Date();

  // Count first, then price. The counter's post-increment total is both the
  // allowance answer and the band selector, so one round trip settles both.
  const { before, after } = await incrementActionCounter(
    args.orgId,
    actions,
    0,
    now,
  );
  const billable = billableActionCount(before, after, allowance);
  const band = resolveActionBand(after);

  if (mode === "shadow" || billable === 0) {
    logger.debug(
      {
        orgId: args.orgId,
        capability: args.capability,
        actions,
        periodActions: after,
        allowance,
        billableActions: billable,
        band: band.id,
        mode,
        durationMs: Date.now() - start,
      },
      mode === "shadow"
        ? "billing: governed action recorded — shadow mode, no debit"
        : "billing: governed action recorded — inside allowance, no debit",
    );
    return {
      periodActions: after,
      billableActions: billable,
      band,
      creditsCharged: 0n,
      shortfallCredits: 0n,
      mode,
    };
  }

  const microCredits = microCreditsForActions(billable, band);
  const { chargedCents, shortfallCents, carryMicroCents } =
    await consumeCredits({
      orgId: args.orgId,
      requestedMicroCents: microCredits,
      // ADR-052: `consume_execution` survives and takes on the action meter.
      // `consume_token_overage` is retired, not repurposed — a historical row
      // keeps meaning what it meant.
      reason: CREDIT_REASONS.CONSUME_EXECUTION,
      referenceType: "governed_action",
      // referenceId is a Postgres uuid column. The run id is the only uuid this
      // path has, and it is legitimately absent for direct API/MCP/human calls —
      // undefined writes NULL, where a fabricated value would group a charge
      // under a run that did not happen.
      referenceId: args.runId ?? undefined,
    });

  // Record what was charged, separately from what was counted. The gap between
  // the two columns is the audit answer to "did every overage action bill".
  await incrementActionCounter(args.orgId, 0, billable, now);

  logger.info(
    {
      orgId: args.orgId,
      capability: args.capability,
      actions,
      periodActions: after,
      allowance,
      billableActions: billable,
      band: band.id,
      usdPer1000: band.usdPer1000,
      microCredits: Number(microCredits),
      creditsCharged: Number(chargedCents),
      shortfallCredits: Number(shortfallCents),
      carryMicroCents: Number(carryMicroCents),
      runId: args.runId ?? null,
      mode,
      durationMs: Date.now() - start,
    },
    "billing: governed action charged",
  );

  return {
    periodActions: after,
    billableActions: billable,
    band,
    creditsCharged: chargedCents,
    shortfallCredits: shortfallCents,
    mode,
  };
}

// ── Retention charge ────────────────────────────────────────────────────────

/**
 * Charge an organisation for a month of evidence held beyond the included
 * twelve (spec §4.3).
 *
 * Opt-in (§7.4): the caller is responsible for checking
 * `org_billing_settings.extended_evidence_retention_enabled` and for
 * establishing the tenant scope. Charging an organisation that never opted in
 * is the surprise this pricing model exists to prevent, so this function
 * refuses rather than trusting the caller — see the guard below.
 */
export async function chargeEvidenceRetention(args: {
  orgId: string;
  /** GB-months held beyond the included window. */
  gbMonths: number;
  /** The org's opt-in flag. False refuses the charge. */
  optedIn: boolean;
}): Promise<{ creditsCharged: bigint; shortfallCredits: bigint }> {
  if (!args.optedIn) {
    logger.debug(
      { orgId: args.orgId, gbMonths: args.gbMonths },
      "billing: extended retention not opted in — no charge",
    );
    return { creditsCharged: 0n, shortfallCredits: 0n };
  }
  const credits = retentionCreditsForGbMonths(args.gbMonths);
  if (credits <= 0n) return { creditsCharged: 0n, shortfallCredits: 0n };

  const { chargedCents, shortfallCents } = await consumeCredits({
    orgId: args.orgId,
    requestedCents: credits,
    reason: CREDIT_REASONS.CONSUME_RETENTION,
    referenceType: "evidence_retention",
  });
  logger.info(
    {
      orgId: args.orgId,
      gbMonths: args.gbMonths,
      usdPerGbMonth: RETENTION_USD_PER_GB_MONTH,
      creditsCharged: Number(chargedCents),
      shortfallCredits: Number(shortfallCents),
    },
    "billing: evidence retention charged",
  );
  return { creditsCharged: chargedCents, shortfallCredits: shortfallCents };
}
