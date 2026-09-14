/**
 * gau-bucket.ts — the organisation's month of governed action units
 * (ADR-055 §4, apps/app/ARCHITECTURE.md §3.9 items 4, 5 and 9).
 *
 * Every `billing.gau_buckets` row covers one month. `periodFor` picks the
 * month; `ensureCurrentBucket(tx, …)` is the one writer — the lazy create and
 * the debit as one upsert on the caller's executor; `readBucket` is the read,
 * which answers with a virtual bucket (and its carry) when no row exists and
 * never inserts; `assertGauAvailable` is the admission gate the kernel runs
 * before a governed action, and it never charges.
 *
 * `remaining = included + purchased + carried − used` and may be negative:
 * the gate checks `remaining > 0` before the handler and the recorder debits
 * after it, so concurrent governed actions can drive `used_gau` past the
 * total. The stored figure is never clamped.
 */

import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { readOrgBillingSettings } from "./billing-settings";
import {
  resolveGauEntitlement,
  type GauSubscriptionPeriod,
} from "./contract-terms";
import { assertOrgCanConsume } from "./dunning";
import { readDefaultPaymentMethod } from "./payment-methods";
import type { GauTerms } from "./pricing";
import { logger } from "./logger";

// ── The period ──────────────────────────────────────────────────────────────

/** A half-open month: `[start, end)`, UTC instants. */
export interface GauPeriod {
  start: Date;
  end: Date;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `anchor` moved `k` calendar months, keeping its time of day and clamping
 * the day to the last day of a shorter month — the way Stripe's billing-cycle
 * anchor behaves, so a cycle anchored on the 31st runs Jan 31 – Feb 28,
 * Feb 28 – Mar 31, Mar 31 – Apr 30. The clamp is from the anchor's day each
 * time, never from the previous slice's, so a February boundary does not pull
 * every later month back to the 28th.
 */
export function addMonths(anchor: Date, k: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + k;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
  return new Date(
    Date.UTC(
      year,
      monthIndex,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * The month bucket `now` falls in.
 *
 * - A `month` subscription: its own `current_period_start` / `_end`.
 * - A `year` subscription: the anniversary-day slice of the cycle that
 *   contains `now`, `[addMonths(start, k), addMonths(start, k + 1))`. `k` is
 *   not capped at 11: a cycle Stripe has renewed but whose webhook has not
 *   landed yet slices on the same anniversary days the renewed row will.
 * - No subscription: the UTC calendar month.
 */
export function periodFor(
  subscription: GauSubscriptionPeriod | null,
  now: Date,
): GauPeriod {
  if (subscription === null) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(y, m, 1)),
      end: new Date(Date.UTC(y, m + 1, 1)),
    };
  }
  if (subscription.billingInterval === "month") {
    return {
      start: subscription.currentPeriodStart,
      end: subscription.currentPeriodEnd,
    };
  }
  const anchor = subscription.currentPeriodStart;
  let k =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  while (addMonths(anchor, k) > now) k -= 1;
  while (addMonths(anchor, k + 1) <= now) k += 1;
  return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
}

// ── The bucket ──────────────────────────────────────────────────────────────

export type GauBucketRow = typeof schema.gauBuckets.$inferSelect;

/** The four counts the balance is made of. */
export interface GauCounts {
  includedGau: number;
  purchasedGau: number;
  carriedGau: number;
  usedGau: number;
}

/** `included + purchased + carried − used`; negative when overdrawn. */
export function remainingGau(b: GauCounts): number {
  return b.includedGau + b.purchasedGau + b.carriedGau - b.usedGau;
}

/**
 * The carry into a new month from the month before it (ADR-055 §4):
 * `min(prev.purchased + prev.carried, max(0, prev.remaining))`. Bought units
 * survive a month boundary; included ones do not; nothing carries from an
 * overdrawn month. Zero when there is no previous bucket.
 */
export function carriedFrom(prev: GauCounts | null): number {
  if (prev === null) return 0;
  return Math.min(
    prev.purchasedGau + prev.carriedGau,
    Math.max(0, remainingGau(prev)),
  );
}

/**
 * The remaining balance as SQL, for a statement that must re-check it under
 * the row lock (the auto top-up claim, gau-settlements.ts).
 *
 * Built on the first call rather than at module scope. The expression reads
 * `schema.gauBuckets`, and reading it while this module is being evaluated
 * makes the import itself throw wherever `@oxagen/database` is mocked without
 * that table — which is every test in the tree that stubs the schema with the
 * handful of tables it uses, 300-odd of them. One such file,
 * `packages/inngest-functions/src/functions/schema.reconcile.handler.test.ts`,
 * reaches this module transitively through `action-metering.ts` and failed to
 * collect at all: `TypeError: Cannot read properties of undefined (reading
 * 'includedGau')`, a suite that never ran rather than a test that failed.
 * Every other reference to the schema in this package is inside a function,
 * so nothing else in the import graph pays that cost.
 *
 * Memoized, so callers that match the expression by identity
 * (`test-utils/gau-fake-tx.ts`) still see exactly one instance per module
 * load, as the former `const` gave them.
 */
let gauRemainingSqlExpr: SQL<number> | undefined;

export function gauRemainingSql(): SQL<number> {
  gauRemainingSqlExpr ??= sql<number>`${schema.gauBuckets.includedGau} + ${schema.gauBuckets.purchasedGau} + ${schema.gauBuckets.carriedGau} - ${schema.gauBuckets.usedGau}`;
  return gauRemainingSqlExpr;
}

/** The latest bucket that ended before `periodStart`, or null. */
async function previousBucket(
  tx: Tx,
  orgId: string,
  periodStart: Date,
): Promise<GauBucketRow | null> {
  const rows = await tx
    .select()
    .from(schema.gauBuckets)
    .where(
      and(
        eq(schema.gauBuckets.orgId, orgId),
        lt(schema.gauBuckets.periodStart, periodStart),
      ),
    )
    .orderBy(desc(schema.gauBuckets.periodStart))
    .limit(1);
  return rows[0] ?? null;
}

export interface EnsureCurrentBucketArgs {
  period: GauPeriod;
  terms: GauTerms;
  /** Governed actions to add to `used_gau`. */
  usedDelta: number;
  /** Units to add to `purchased_gau` (a paid settlement's grant). */
  purchasedDelta: number;
}

/**
 * The lazy create and the debit as one statement on the caller's executor:
 *
 *   INSERT INTO billing.gau_buckets (…) VALUES (…)
 *   ON CONFLICT (org_id, period_start) DO UPDATE
 *     SET used_gau = gau_buckets.used_gau + EXCLUDED.used_gau,
 *         purchased_gau = gau_buckets.purchased_gau + EXCLUDED.purchased_gau
 *   RETURNING *
 *
 * The insert branch carries `included_gau` from the terms and `carried_gau`
 * from the previous bucket, read before the statement; if two callers race
 * the create, one inserts and the other lands in the conflict branch. The
 * upsert takes the row lock, so a concurrent action for the same organisation
 * waits and reads the post-write total — the boundary is exact under
 * concurrency. Every writer of the bucket goes through here, with
 * `usedDelta: 0` for a grant.
 */
export async function ensureCurrentBucket(
  tx: Tx,
  orgId: string,
  args: EnsureCurrentBucketArgs,
): Promise<GauBucketRow> {
  const used = Math.max(0, Math.floor(args.usedDelta));
  const purchased = Math.max(0, Math.floor(args.purchasedDelta));
  const prev = await previousBucket(tx, orgId, args.period.start);
  const rows = await tx
    .insert(schema.gauBuckets)
    .values({
      orgId,
      periodStart: args.period.start,
      periodEnd: args.period.end,
      includedGau: args.terms.includedGauPerMonth,
      carriedGau: carriedFrom(prev),
      usedGau: used,
      purchasedGau: purchased,
    })
    .onConflictDoUpdate({
      target: [schema.gauBuckets.orgId, schema.gauBuckets.periodStart],
      set: {
        usedGau: sql`${schema.gauBuckets.usedGau} + excluded.used_gau`,
        purchasedGau: sql`${schema.gauBuckets.purchasedGau} + excluded.purchased_gau`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    // An upsert with RETURNING always yields the row; only a driver fault
    // reaches here, and a silent zero would under-bill.
    throw new Error("billing: gau_buckets upsert returned no row");
  }
  return row;
}

/**
 * The month's bucket as the page and the gate see it: the stored row, or a
 * virtual bucket — `included` from the terms, `carried` by the rollover
 * formula from the previous row, everything else zero — when no row exists
 * yet. `id` is null exactly for the virtual bucket.
 */
export interface GauBucketView extends GauCounts {
  id: string | null;
  periodStart: Date;
  periodEnd: Date;
  overageInvoicedGau: number;
  interimSeq: number;
  topupSeq: number;
  openTopupSettlementId: string | null;
  closedAt: Date | null;
  remainingGau: number;
}

/** The read. Never inserts: the recorder's lazy create is the only writer. */
export async function readBucket(
  orgId: string,
  args: { period: GauPeriod; terms: GauTerms },
): Promise<GauBucketView> {
  const { current, prev } = await withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.gauBuckets)
      .where(
        and(
          eq(schema.gauBuckets.orgId, orgId),
          eq(schema.gauBuckets.periodStart, args.period.start),
        ),
      )
      .limit(1);
    const c = rows[0] ?? null;
    return {
      current: c,
      prev:
        c === null ? await previousBucket(tx, orgId, args.period.start) : null,
    };
  });
  if (current !== null) {
    return { ...current, remainingGau: remainingGau(current) };
  }
  const virtual: GauCounts = {
    includedGau: args.terms.includedGauPerMonth,
    purchasedGau: 0,
    carriedGau: carriedFrom(prev),
    usedGau: 0,
  };
  return {
    id: null,
    periodStart: args.period.start,
    periodEnd: args.period.end,
    ...virtual,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null,
    closedAt: null,
    remainingGau: remainingGau(virtual),
  };
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Why a prepaid organisation at `remaining ≤ 0` was refused, when the page
 * has something more useful to say than "buy more": a Free org that has not
 * saved a card is refused until the next month opens or it saves one
 * (ADR-055 §6, the 2026-09-14 rule). Null for every other prepaid org — its
 * auto top-up ran or could not, exactly as for Build.
 */
export type GauExhaustedReason = "free_no_payment_method";

export class GauExhaustedError extends Error {
  readonly code = "gau_exhausted" as const;
  readonly reason: GauExhaustedReason | null;
  readonly remainingGau: number;
  readonly periodEnd: Date;

  constructor(args: {
    reason: GauExhaustedReason | null;
    remainingGau: number;
    periodEnd: Date;
  }) {
    super(
      args.reason === "free_no_payment_method"
        ? `Governed action units exhausted: add a payment method to keep governing this month, or the allowance renews on ${args.periodEnd.toISOString()}.`
        : "Governed action units exhausted: the bucket is empty and auto top-up could not run.",
    );
    this.name = "GauExhaustedError";
    this.reason = args.reason;
    this.remainingGau = args.remainingGau;
    this.periodEnd = args.periodEnd;
  }
}

/**
 * The admission gate (ARCHITECTURE.md §3.9 item 9). Runs inside the kernel's
 * tenant scope before every governed action:
 *
 *   1. `BillingSuspendedError` when dunning has suspended the org — in
 *      either mode (`assertOrgCanConsume`, unchanged).
 *   2. Returns for an org approved for invoice billing at any `remaining`.
 *   3. Returns for a prepaid org with `remaining > 0`.
 *   4. Otherwise `GauExhaustedError`, with `reason: "free_no_payment_method"`
 *      when the resolved terms are the published Free tier and the org has no
 *      default payment method.
 *
 * Reads only: the settings through `readOrgBillingSettings`, the bucket
 * through `readBucket`. Never inserts, never calls the provider — a gate that
 * charges fails open when Stripe is down.
 */
export async function assertGauAvailable(
  orgId: string,
  now: Date = new Date(),
): Promise<void> {
  await assertOrgCanConsume(orgId);

  const settings = await readOrgBillingSettings(orgId);
  if (settings.approvedForInvoiceBilling) return;

  const { terms, subscription } = await resolveGauEntitlement(orgId, now);
  const period = periodFor(subscription, now);
  const bucket = await readBucket(orgId, { period, terms });
  if (bucket.remainingGau > 0) return;

  const reason: GauExhaustedReason | null =
    terms.source === "published_tier" &&
    terms.tier === "free" &&
    (await readDefaultPaymentMethod(orgId)) === null
      ? "free_no_payment_method"
      : null;

  logger.warn(
    {
      orgId,
      remainingGau: bucket.remainingGau,
      periodEnd: period.end.toISOString(),
      tier: terms.tier,
      source: terms.source,
      reason,
    },
    "billing: assertGauAvailable — bucket exhausted, refusing governed action",
  );
  throw new GauExhaustedError({
    reason,
    remainingGau: bucket.remainingGau,
    periodEnd: period.end,
  });
}
