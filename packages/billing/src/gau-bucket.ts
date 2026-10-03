/**
 * gau-bucket.ts: the organisation's bucket of governed action units
 * (ADR-055 §4, amended by ADR-241 signup grant; apps/app/ARCHITECTURE.md §3.9
 * items 4, 5 and 9).
 *
 * A `billing.gau_buckets` row covers a subscriber's month, a new
 * organisation's signup grant window, or a calendar month after the grant.
 * `bucketBasis` picks which, with `periodFor` slicing a subscription's month;
 * `ensureCurrentBucket(tx, …)` is the one writer — the lazy create and
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
import type { GauTerms } from "./pricing";
import { signupGrantActive, type SignupGrant } from "./signup-grant";
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

// ── The basis ───────────────────────────────────────────────────────────────

/**
 * What the organisation's current bucket is measured against (ADR-241,
 * signup grant, amending ADR-055 §4):
 *
 * - `subscription`: an entitled subscription's month (`periodFor`), with the
 *   plan's or the negotiated row's monthly allowance.
 * - `signup_grant`: no subscription, inside the grant's window. The bucket's
 *   period is exactly `[granted_at, expires_at)` and its included units are
 *   the grant.
 * - `after_signup_grant`: no subscription, and the grant expired or never
 *   existed. The UTC calendar month, starting no earlier than the grant's
 *   expiry so the two buckets never overlap. Its allowance is zero while the
 *   Free row requires a subscription, and the Free row's monthly allowance
 *   when an operator has cleared that rule.
 */
export type GauBasisKind = "subscription" | "signup_grant" | "after_signup_grant";

export interface GauBucketBasis<T extends GauTerms = GauTerms> {
  kind: GauBasisKind;
  period: GauPeriod;
  /** The terms, with `includedGauPerMonth` set to this period's allowance. */
  terms: T;
}

/** What `bucketBasis` reads from an entitlement. */
export interface GauBasisInput<T extends GauTerms = GauTerms> {
  terms: T;
  subscription: GauSubscriptionPeriod | null;
  grant?: SignupGrant | null;
  subscriptionRequiredAfterGrant?: boolean;
}

/**
 * The period and allowance of the bucket `now` falls in. Every reader and
 * writer of the bucket takes its period from here, so the gate, the recorder,
 * the page and the settlement paths always address the same row.
 */
export function bucketBasis<T extends GauTerms>(
  entitlement: GauBasisInput<T>,
  now: Date,
): GauBucketBasis<T> {
  const { terms, subscription } = entitlement;
  if (subscription !== null) {
    return {
      kind: "subscription",
      period: periodFor(subscription, now),
      terms,
    };
  }
  const grant = entitlement.grant ?? null;
  if (grant !== null && signupGrantActive(grant, now)) {
    return {
      kind: "signup_grant",
      period: { start: grant.grantedAt, end: grant.expiresAt },
      terms: { ...terms, includedGauPerMonth: grant.grantedGau },
    };
  }
  const month = periodFor(null, now);
  const start =
    grant !== null && grant.expiresAt > month.start
      ? grant.expiresAt
      : month.start;
  return {
    kind: "after_signup_grant",
    period: { start, end: month.end },
    terms: {
      ...terms,
      includedGauPerMonth: entitlement.subscriptionRequiredAfterGrant
        ? 0
        : terms.includedGauPerMonth,
    },
  };
}

// ── The block ───────────────────────────────────────────────────────────────

/**
 * The price of one block in minor units of the terms' currency:
 * `rate_per_gau_micros × block_size_gau ÷ 10,000`. The CHECK on both terms
 * tables (`(rate_per_gau_micros * block_size_gau) % 10000 = 0`) makes the
 * division exact, so a Checkout line needs no rounding; terms that violate
 * it did not come from those tables and are refused rather than rounded.
 */
export function blockPriceCents(
  terms: Pick<GauTerms, "ratePerGauMicros" | "blockSizeGau">,
): number {
  const micros = terms.ratePerGauMicros * BigInt(terms.blockSizeGau);
  if (micros % 10_000n !== 0n) {
    throw new Error(
      `billing: block price is not a whole number of cents (${micros} micros)`,
    );
  }
  return Number(micros / 10_000n);
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
 * Overage this month that no settlement has claimed yet:
 * `max(0, used − included − purchased − carried) − overage_invoiced`, floored
 * at zero. The recorder's interim threshold, the close job and
 * `get_gau_bucket` read it; `claimInterimInvoice` re-checks the same
 * subtraction under the row lock (gauUninvoicedSql).
 */
export function uninvoicedGau(
  b: GauCounts & { overageInvoicedGau: number },
): number {
  const overage = Math.max(
    0,
    b.usedGau - b.includedGau - b.purchasedGau - b.carriedGau,
  );
  return Math.max(0, overage - b.overageInvoicedGau);
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

let gauUninvoicedSqlExpr: SQL<number> | undefined;

/**
 * `used − included − purchased − carried − overage_invoiced` as SQL, for the
 * interim claim's re-checked WHERE. Built on first call for the reason
 * `gauRemainingSql` is.
 */
export function gauUninvoicedSql(): SQL<number> {
  gauUninvoicedSqlExpr ??= sql<number>`${schema.gauBuckets.usedGau} - ${schema.gauBuckets.includedGau} - ${schema.gauBuckets.purchasedGau} - ${schema.gauBuckets.carriedGau} - ${schema.gauBuckets.overageInvoicedGau}`;
  return gauUninvoicedSqlExpr;
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
 * Why an organisation with no subscription was refused (ADR-241, signup
 * grant). The first three ask the same thing of the customer: add a card
 * and choose a plan. A saved card alone changes none of them.
 *
 * - `signup_grant_used`: inside the grant's window, with the grant spent.
 * - `signup_grant_expired`: the grant's window has closed.
 * - `no_signup_grant`: the organisation has no grant row.
 * - `monthly_allowance_used`: an operator has cleared the subscription rule,
 *   and the Free row's monthly allowance is spent.
 */
export type GauExhaustedReason =
  | "signup_grant_used"
  | "signup_grant_expired"
  | "no_signup_grant"
  | "monthly_allowance_used";

function exhaustedMessage(
  reason: GauExhaustedReason | null,
  periodEnd: Date,
): string {
  switch (reason) {
    case null:
      return "Governed actions exhausted: add a card and choose a plan to keep governing.";
    case "signup_grant_used":
      return "Signup grant used: add a card and choose a plan to keep governing.";
    case "signup_grant_expired":
      return "Signup grant expired: add a card and choose a plan to keep governing.";
    case "no_signup_grant":
      return "No plan: add a card and choose a plan to keep governing.";
    case "monthly_allowance_used":
      return `Monthly allowance used: choose a plan to keep governing, or wait until ${periodEnd.toISOString()}.`;
  }
}

/**
 * Whether the gate refuses the organisation without reading its bucket: no
 * subscription, past the signup grant or with none, while the Free row
 * requires a subscription. Units bought in this state land on a bucket the
 * gate never reads, so `purchase_gau_bucket` refuses them with this same
 * test (#4886). A subscriber, an organisation inside its grant, and one whose
 * subscription rule an operator has cleared all have their bought units
 * counted.
 */
export function requiresSubscription(
  basis: Pick<GauBucketBasis, "kind">,
  entitlement: Pick<GauBasisInput, "subscriptionRequiredAfterGrant">,
): boolean {
  return (
    basis.kind === "after_signup_grant" &&
    entitlement.subscriptionRequiredAfterGrant === true
  );
}

export class GauExhaustedError extends Error {
  readonly code = "gau_exhausted" as const;
  /** Null only from a caller other than the gate, which always names one. */
  readonly reason: GauExhaustedReason | null;
  readonly remainingGau: number;
  /** When the refused bucket ends: the grant's expiry, or the month's end. */
  readonly periodEnd: Date;

  constructor(args: {
    reason: GauExhaustedReason | null;
    remainingGau: number;
    periodEnd: Date;
  }) {
    super(exhaustedMessage(args.reason, args.periodEnd));
    this.name = "GauExhaustedError";
    this.reason = args.reason;
    this.remainingGau = args.remainingGau;
    this.periodEnd = args.periodEnd;
  }
}

/**
 * The admission gate (ARCHITECTURE.md §3.9 item 9; ADR-241, signup grant).
 * Runs inside the kernel's tenant scope before every governed action:
 *
 *   1. `BillingSuspendedError` when dunning has suspended the org
 *      (`assertOrgCanConsume`), whatever else is true.
 *   2. Returns for an org approved for invoice billing.
 *   3. Returns for an org with an entitled subscription. Actions past the
 *      plan's allowance are billed as usage on the subscription invoice, so
 *      a subscriber is never capped here.
 *   4. Inside the signup grant's window, returns while the grant has units
 *      left, and refuses with `signup_grant_used` once it has none.
 *   5. After the grant, or with none, refuses with `signup_grant_expired` or
 *      `no_signup_grant` while the Free row requires a subscription. When an
 *      operator has cleared that rule, the Free row's monthly allowance
 *      admits instead, and `monthly_allowance_used` refuses past it.
 *
 * A saved card plays no part: it unlocks nothing without a subscription.
 * Reads only, through `readOrgBillingSettings`, `resolveGauEntitlement` and
 * `readBucket`. Never inserts and never calls the provider, so a Stripe
 * outage cannot make the gate fail open.
 */
export async function assertGauAvailable(
  orgId: string,
  now: Date = new Date(),
): Promise<void> {
  await assertOrgCanConsume(orgId);

  const settings = await readOrgBillingSettings(orgId);
  if (settings.approvedForInvoiceBilling) return;

  const entitlement = await resolveGauEntitlement(orgId, now);
  const basis = bucketBasis(entitlement, now);
  if (basis.kind === "subscription") return;

  const grant = entitlement.grant ?? null;
  let reason: GauExhaustedReason;
  let remaining = 0;
  if (requiresSubscription(basis, entitlement)) {
    reason = grant === null ? "no_signup_grant" : "signup_grant_expired";
  } else {
    const bucket = await readBucket(orgId, basis);
    if (bucket.remainingGau > 0) return;
    remaining = bucket.remainingGau;
    reason =
      basis.kind === "signup_grant" ? "signup_grant_used" : "monthly_allowance_used";
  }

  logger.warn(
    {
      orgId,
      remainingGau: remaining,
      periodEnd: basis.period.end.toISOString(),
      basis: basis.kind,
      tier: entitlement.terms.tier,
      source: entitlement.terms.source,
      reason,
    },
    "billing: assertGauAvailable refused a governed action",
  );
  throw new GauExhaustedError({
    reason,
    remainingGau: remaining,
    periodEnd: basis.period.end,
  });
}
