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
 * The rate card and the annual allowances below are what the rate-card and
 * estimate capabilities publish; the recorder prices nothing by them. Rates:
 * docs/specs/governed-action-metering.md §4.
 */

import { randomUUID } from "node:crypto";
import { withTenantDb } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import { readOrgBillingSettings } from "./billing-settings";
import { resolveGauEntitlement } from "./contract-terms";
import { ensureStripeCustomer } from "./customers";
import {
  periodFor,
  remainingGau,
  uninvoicedGau,
  type GauBucketRow,
} from "./gau-bucket";
import {
  debitWithLedger,
  governedActionEntry,
  type GovernedActionEntry,
} from "./gau-ledger";
import {
  claimAutoTopup,
  claimInterimInvoice,
  settleGauInvoice,
  type GauSettlementRow,
} from "./gau-settlements";
import { readDefaultPaymentMethod } from "./payment-methods";
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
 * These are the DEFAULTS. The authoritative figure is the organisation's own
 * plan row, read as `included_gau_per_month × 12`
 * (`resolveOrgActionEntitlement`, plan-allowance.ts). This table is what an
 * organisation with no plan row falls back to, and what the rate-card
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
 * Included actions for a tier, given the plan row's own figure if there is
 * one. `planIncluded` comes from `resolveOrgActionEntitlement`, which reads it
 * as `billing.plans.included_gau_per_month × 12`.
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
    "billing: enterprise plan carries no annual allowance; falling back to the scale allowance rather than treating it as unlimited",
  );
  return ENTERPRISE_FALLBACK_ALLOWANCE;
}

// ── Retention (spec §4.3) ───────────────────────────────────────────────────

/** Evidence retention included on every paid tier, in months. */
export const RETENTION_INCLUDED_MONTHS = 12;

/** USD per GB-month for evidence held beyond {@link RETENTION_INCLUDED_MONTHS}. */
export const RETENTION_USD_PER_GB_MONTH = 0.08;

// ── The entitlement period ──────────────────────────────────────────────────

/**
 * First instant of the entitlement year containing `now`, UTC.
 *
 * The calendar year, because the published volume bands (§4.1) are annual and
 * a calendar year needs no per-org state to compute. The GAU bucket the
 * recorder debits has nothing to do with this window — it runs on the
 * organisation's own month (`periodFor`, gau-bucket.ts). What is left here is
 * the evidence-retention window `get_evidence_retention` reports.
 */
export function actionPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
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
  /**
   * The ledger row for this action (ADR-158). Absent only for a caller that
   * predates the ledger; the recorder then writes a row with the capability
   * and run it was given and a key unique to this call, so nothing is
   * deduplicated and nothing goes unrecorded.
   */
  entry?: GovernedActionEntry;
  now?: Date;
}

export interface RecordActionResult {
  /** The organisation's month bucket after this action landed. */
  bucket: GauBucketRow;
  /** `included + purchased + carried − used` after the debit; negative when overdrawn. */
  remainingGau: number;
  /** The organisation's billing mode at the time of the debit. */
  mode: "prepaid" | "invoice";
  /** Units this call added to the bucket: 0 when every entry was already on the ledger. */
  billedUnits: number;
  /** Entries whose idempotency key was already on the ledger. */
  duplicates: number;
  /** The auto top-up episode this action claimed, as claimed, or null when none was. */
  autoTopup: GauSettlementRow | null;
  /** The interim invoice this action's threshold crossing claimed, as claimed, or null. */
  interimInvoice: GauSettlementRow | null;
}

/**
 * Record one governed action (or a batch of them, for a contract that declares
 * a `meter` block) against the organisation's month bucket
 * (ARCHITECTURE.md §3.9 item 8). The single-action form of
 * {@link recordGovernedActions}, kept for the kernel recorder.
 */
export async function recordGovernedAction(
  args: RecordActionArgs,
): Promise<RecordActionResult> {
  const now = args.now ?? new Date();
  const actions = Math.max(1, Math.floor(args.actions));
  const entry =
    args.entry ??
    governedActionEntry({
      idempotencyKey: `kernel:inv:${randomUUID()}`,
      source: "kernel",
      units: actions,
      occurredAt: now,
      capability: args.capability,
      runId: args.runId ?? null,
    });
  return recordGovernedActions({
    orgId: args.orgId,
    entries: [{ ...entry, units: actions }],
    now,
    label: args.capability,
  });
}

export interface RecordActionsArgs {
  orgId: string;
  /** The actions to record. Duplicates of rows already on the ledger bill nothing. */
  entries: readonly GovernedActionEntry[];
  /** Logged: the capability, or a summary such as `tacho:tool_calls`. */
  label: string;
  now?: Date;
}

/**
 * Record governed actions against the organisation's month bucket and its
 * ledger (ADR-055, ADR-158).
 *
 *   a. Resolve the terms, the settings and the period.
 *   b. Debit: `debitWithLedger` writes one `billing.gau_ledger` row per entry
 *      that is not already there and adds exactly those units to the month
 *      bucket, in one transaction of its own, so the count lands whatever
 *      happens after it. Duplicates — a retried tool call, a re-sent Tacho
 *      batch — insert nothing and debit nothing.
 *   c. Prepaid, at `remaining ≤ 0`, with auto top-up on and a saved default
 *      card: claim at most one auto top-up episode (`claimAutoTopup`, its own
 *      transaction, committed before any provider call), then run the
 *      settlement sequence charging that card, for the customer on
 *      `org_billing_settings.stripe_customer_id`. A Free organisation with no
 *      card claims nothing — the gate refuses its next action with
 *      `reason: "free_no_payment_method"` until it saves one or the next month
 *      opens (ADR-055 §6).
 *   d. Invoice billing, with uninvoiced overage at `invoice_gau_max`: claim
 *      exactly `invoice_gau_max` as an interim invoice (committed), then the
 *      same sequence for the customer `ensureStripeCustomer` resolves,
 *      collected from the org's default card or emailed when it has none.
 *
 * Steps c and d run only when this call billed something: when every entry was
 * a duplicate, the call that first recorded them already ran them.
 *
 * Runs inside the tenant scope of its caller. Everything after the debit is
 * caught here so a claim that fails cannot surface as a broken request whose
 * work is already done; the debit itself throws, so a caller that can retry
 * (a Tacho batch the host will re-send) can, and the ledger makes the retry
 * safe.
 */
export async function recordGovernedActions(
  args: RecordActionsArgs,
): Promise<RecordActionResult> {
  const start = Date.now();
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

  // b. Debit and itemise, one transaction.
  const { bucket, billedUnits, duplicates } = await withTenantDb((tx) =>
    debitWithLedger(tx, args.orgId, {
      period,
      terms,
      entries: args.entries,
      billedAt: now,
    }),
  );
  const remaining = remainingGau(bucket);

  let autoTopup: GauSettlementRow | null = null;
  let interimInvoice: GauSettlementRow | null = null;
  try {
    if (billedUnits === 0) {
      // Every entry was already on the ledger; the call that recorded them
      // ran the settlement steps.
      return {
        bucket,
        remainingGau: remaining,
        mode,
        billedUnits,
        duplicates,
        autoTopup,
        interimInvoice,
      };
    }
    // c. Prepaid: at most one auto top-up episode at a time.
    if (mode === "prepaid" && remaining <= 0 && settings.autoTopupEnabled) {
      const card = await readDefaultPaymentMethod(args.orgId);
      if (card !== null) {
        autoTopup = await withTenantDb((tx) =>
          claimAutoTopup(tx, bucket, terms, settings.autoTopupBlocks),
        );
        if (autoTopup !== null) {
          const customerId = settings.stripeCustomerId;
          await settleGauInvoice(autoTopup, {
            run: withTenantDb,
            customerId: async () => {
              // A default card exists only after a Checkout or a SetupIntent,
              // each of which wrote the column through ensureStripeCustomer.
              if (customerId === null) {
                throw new Error(
                  "billing: org has a default card and no stripe_customer_id",
                );
              }
              return customerId;
            },
            defaultPaymentMethodId: async () => card.stripePaymentMethodId,
          });
        }
      }
    }

    // d. Invoice billing: one interim settlement per threshold crossing.
    if (mode === "invoice" && uninvoicedGau(bucket) >= settings.invoiceGauMax) {
      interimInvoice = await withTenantDb((tx) =>
        claimInterimInvoice(tx, bucket, terms, settings.invoiceGauMax),
      );
      if (interimInvoice !== null) {
        await settleGauInvoice(interimInvoice, {
          run: withTenantDb,
          customerId: () => ensureStripeCustomer(args.orgId),
          defaultPaymentMethodId: async () =>
            (await readDefaultPaymentMethod(args.orgId))
              ?.stripePaymentMethodId ?? null,
        });
      }
    }
  } catch (error) {
    logger.error(
      {
        orgId: args.orgId,
        label: args.label,
        billedUnits,
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
      label: args.label,
      entries: args.entries.length,
      billedUnits,
      duplicates,
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
      interimInvoiceSettlementId: interimInvoice?.id ?? null,
      durationMs: Date.now() - start,
    },
    "billing: governed action recorded",
  );

  return {
    bucket,
    remainingGau: remaining,
    mode,
    billedUnits,
    duplicates,
    autoTopup,
    interimInvoice,
  };
}
