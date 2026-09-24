/**
 * gau-settlements.ts — the settlement ledger in motion (ADR-055 §6,
 * apps/app/ARCHITECTURE.md §3.9 items 7, 8c, 8d, 10, 11 and 12).
 *
 * Every writer takes its executor first, the shape `tryInsertGrantLedger(tx,
 * …)` has: the recorder passes a `withTenantDb` transaction, the webhooks,
 * the close job and the operator handler a `withSystemDb` one. The claims
 * (`claimAutoTopup`, `claimInterimInvoice`, the period-close claim) insert a
 * `pending` row in the claim's transaction; the caller commits it before the
 * settlement sequence (`settleGauInvoice`) makes its first provider call, so
 * a crash after the commit leaves a row the hourly job resumes. `paid` is the
 * only terminal status, and `settleGauPaid` grants once whichever of the
 * synchronous result, the first `invoice.paid` or Stripe's retry lands first.
 * An auto top-up's episode ends when its row is marked `paid` or `failed`;
 * an `open` row keeps it.
 */

// tenancy: system bypass via withSystemDb in grantGauPurchaseForCheckout (the
// checkout.session.completed webhook: the org comes from the session metadata),
// in closeInvoiceAccrual (set_org_billing_terms: an unscoped platform-operator
// call keyed on its input's org), and in closeEndedGauPeriods and
// resumePendingGauSettlements (the billing.gau-close job, across every org).
// None runs inside a tenant scope, and withTenantDb there throws
// TenantScopeError under enforced RLS.

import { and, asc, eq, gt, gte, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { readOrgBillingSettings } from "./billing-settings";
import { billingProvider } from "./client";
import { readGauEntitlement } from "./contract-terms";
import { ensureStripeCustomer } from "./customers";
import {
  ensureCurrentBucket,
  gauRemainingSql,
  gauUninvoicedSql,
  periodFor,
  remainingGau,
  uninvoicedGau,
  type GauBucketRow,
} from "./gau-bucket";
import { reconcilePendingGauReversals } from "./gau-reversals";
import { logger } from "./logger";
import { readDefaultPaymentMethod } from "./payment-methods";
import type { GauTerms } from "./pricing";
import type { BillingCheckoutSession, GauInvoiceKind } from "./provider";
import { formatPeriod, type InvoicePeriod } from "./invoice-copy";

export type GauSettlementRow = typeof schema.gauSettlements.$inferSelect;

type SettlementTerms = Pick<GauTerms, "ratePerGauMicros" | "currency">;

/** The `pending` row a claim inserts, at the rate and currency in force at claim time. */
async function insertPendingSettlement(
  tx: Tx,
  args: {
    id: string;
    bucket: Pick<GauBucketRow, "id" | "orgId">;
    kind: "auto_topup" | "interim_invoice" | "period_close";
    seq: number;
    quantityGau: number;
    terms: SettlementTerms;
  },
): Promise<GauSettlementRow> {
  const rows = await tx
    .insert(schema.gauSettlements)
    .values({
      id: args.id,
      orgId: args.bucket.orgId,
      bucketId: args.bucket.id,
      kind: args.kind,
      seq: args.seq,
      quantityGau: args.quantityGau,
      ratePerGauMicros: args.terms.ratePerGauMicros,
      currency: args.terms.currency,
      status: "pending",
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("billing: gau_settlements insert returned no row");
  }
  return row;
}

// ── The claims ──────────────────────────────────────────────────────────────

/**
 * Claim the bucket's auto top-up episode and insert its `pending` settlement.
 *
 *   UPDATE billing.gau_buckets
 *      SET open_topup_settlement_id = :id, topup_seq = topup_seq + 1
 *    WHERE id = :bucket
 *      AND open_topup_settlement_id IS NULL
 *      AND included_gau + purchased_gau + carried_gau − used_gau <= 0
 *   RETURNING topup_seq
 *
 * Postgres re-evaluates the WHERE after the row lock is granted, so of N
 * concurrent recorders exactly one gets a row back and the rest get null; the
 * unique index on `(bucket_id, kind, seq)` backs that up. The settlement is
 * inserted in the same transaction (`quantity_gau = blocks × block_size_gau`).
 *
 * Returns null when the episode was already open or the bucket is no longer
 * exhausted — no row is written in that case.
 */
export async function claimAutoTopup(
  tx: Tx,
  bucket: Pick<GauBucketRow, "id" | "orgId">,
  terms: GauTerms,
  blocks: number,
): Promise<GauSettlementRow | null> {
  const settlementId = crypto.randomUUID();
  const claimed = await tx
    .update(schema.gauBuckets)
    .set({
      openTopupSettlementId: settlementId,
      topupSeq: sql`${schema.gauBuckets.topupSeq} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.gauBuckets.id, bucket.id),
        isNull(schema.gauBuckets.openTopupSettlementId),
        lte(gauRemainingSql(), 0),
      ),
    )
    .returning({ topupSeq: schema.gauBuckets.topupSeq });
  const seq = claimed[0]?.topupSeq;
  if (seq === undefined) return null;
  return insertPendingSettlement(tx, {
    id: settlementId,
    bucket,
    kind: "auto_topup",
    seq,
    quantityGau: Math.max(1, Math.floor(blocks)) * terms.blockSizeGau,
    terms,
  });
}

/**
 * Claim `quantity` GAUs of the bucket's uninvoiced overage for an interim
 * invoice and insert its `pending` settlement.
 *
 *   UPDATE billing.gau_buckets
 *      SET overage_invoiced_gau = overage_invoiced_gau + :quantity,
 *          interim_seq = interim_seq + 1
 *    WHERE id = :bucket
 *      AND used_gau − included_gau − purchased_gau − carried_gau
 *          − overage_invoiced_gau >= :quantity
 *   RETURNING interim_seq
 *
 * The re-checked WHERE gives one claim per threshold crossing; a second
 * crossing in the month gets the next seq, and accrual restarts past the
 * claimed quantity because the claim subtracts exactly that. The recorder
 * passes `invoice_gau_max`; closing the accrual when invoice billing is
 * switched off passes the whole uninvoiced figure. Never touches
 * `purchased_gau`. Returns null when the UPDATE touched no row.
 */
export async function claimInterimInvoice(
  tx: Tx,
  bucket: Pick<GauBucketRow, "id" | "orgId">,
  terms: SettlementTerms,
  quantity: number,
): Promise<GauSettlementRow | null> {
  const claimed = await tx
    .update(schema.gauBuckets)
    .set({
      overageInvoicedGau: sql`${schema.gauBuckets.overageInvoicedGau} + ${quantity}`,
      interimSeq: sql`${schema.gauBuckets.interimSeq} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.gauBuckets.id, bucket.id),
        gte(gauUninvoicedSql(), quantity),
      ),
    )
    .returning({ interimSeq: schema.gauBuckets.interimSeq });
  const seq = claimed[0]?.interimSeq;
  if (seq === undefined) return null;
  return insertPendingSettlement(tx, {
    id: crypto.randomUUID(),
    bucket,
    kind: "interim_invoice",
    seq,
    quantityGau: quantity,
    terms,
  });
}

// ── The settlement writers ──────────────────────────────────────────────────

/** `SET stripe_invoice_id = :invoice WHERE id = :id AND stripe_invoice_id IS NULL`. */
export async function recordGauInvoice(
  tx: Tx,
  id: string,
  stripeInvoiceId: string,
): Promise<void> {
  await tx
    .update(schema.gauSettlements)
    .set({ stripeInvoiceId })
    .where(
      and(
        eq(schema.gauSettlements.id, id),
        isNull(schema.gauSettlements.stripeInvoiceId),
      ),
    );
}

/**
 * Mark a settlement paid and, for the kinds that buy units, grant them:
 *
 *   UPDATE gau_settlements SET status = 'paid', settled_at = now()
 *    WHERE id = :id AND status <> 'paid' RETURNING *
 *
 * and only when that returned a row, for `checkout` and `auto_topup`, the
 * quantity onto the org's CURRENT bucket through `ensureCurrentBucket` (a
 * payment Stripe collects after rollover lands on the month it arrives in,
 * never on a closed bucket whose carry was already computed) and
 * `open_topup_settlement_id` cleared wherever it names this row. The guard
 * makes every arrival after the first a no-op; a row that was `open` or
 * `failed` still grants when its invoice is paid. Returns the updated row,
 * or null when it was already paid.
 */
export async function settleGauPaid(
  tx: Tx,
  id: string,
  now: Date = new Date(),
): Promise<GauSettlementRow | null> {
  const rows = await tx
    .update(schema.gauSettlements)
    .set({ status: "paid", settledAt: sql`now()` })
    .where(
      and(
        eq(schema.gauSettlements.id, id),
        ne(schema.gauSettlements.status, "paid"),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return null;
  if (row.kind === "checkout" || row.kind === "auto_topup") {
    const { terms, subscription } = await readGauEntitlement(
      tx,
      row.orgId,
      now,
    );
    await ensureCurrentBucket(tx, row.orgId, {
      period: periodFor(subscription, now),
      terms,
      usedDelta: 0,
      purchasedDelta: row.quantityGau,
    });
    await endTopupEpisode(tx, row.id);
  }
  return row;
}

/**
 * `UPDATE gau_buckets SET open_topup_settlement_id = NULL WHERE
 * open_topup_settlement_id = :id`: the settlement no longer holds the
 * bucket's auto top-up episode, so the next exhaustion claims a new one.
 */
async function endTopupEpisode(tx: Tx, settlementId: string): Promise<void> {
  await tx
    .update(schema.gauBuckets)
    .set({ openTopupSettlementId: null, updatedAt: sql`now()` })
    .where(eq(schema.gauBuckets.openTopupSettlementId, settlementId));
}

async function settlePending(
  tx: Tx,
  id: string,
  status: "open" | "failed",
): Promise<GauSettlementRow | null> {
  const rows = await tx
    .update(schema.gauSettlements)
    .set({ status })
    .where(
      and(
        eq(schema.gauSettlements.id, id),
        eq(schema.gauSettlements.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Stripe holds a finalized, unpaid invoice for a `pending` row. An auto
 * top-up keeps its episode open, so the month gets no second automatic
 * attempt until this row is paid, a Checkout clears it, or the month ends.
 */
export async function settleGauOpen(
  tx: Tx,
  id: string,
): Promise<GauSettlementRow | null> {
  return settlePending(tx, id, "open");
}

/**
 * Oxagen holds no collectable invoice for a `pending` row (item 7). A failed
 * auto top-up ends its episode: `open_topup_settlement_id` is cleared wherever
 * it names the row, so the org's next exhaustion in the month claims again.
 * Only `open` keeps an episode set, because Stripe is still collecting.
 */
export async function settleGauFailed(
  tx: Tx,
  id: string,
): Promise<GauSettlementRow | null> {
  const row = await settlePending(tx, id, "failed");
  if (row?.kind === "auto_topup") await endTopupEpisode(tx, row.id);
  return row;
}

// ── The settlement sequence ─────────────────────────────────────────────────

/** The payment term of an emailed settlement invoice. */
const GAU_INVOICE_DAYS_UNTIL_DUE = 30;

const INVOICE_KINDS: Partial<
  Record<string, { kind: GauInvoiceKind; label: string }>
> = {
  auto_topup: {
    kind: "gau_auto_topup",
    label: "Governed action units, auto top-up",
  },
  interim_invoice: {
    kind: "gau_interim",
    label: "Governed action units, interim overage",
  },
  period_close: {
    kind: "gau_period_close",
    label: "Governed action units, month-end overage",
  },
};

/**
 * The settlement line as a finance team reads it: what it is, the bucket
 * month it bills, and the agreement when the org has negotiated terms, e.g.
 * "Governed action units, month-end overage: 1 Sep to 30 Sep 2026
 * (agreement MSA-2026-014)".
 */
function settlementLineDescription(
  label: string,
  period: InvoicePeriod,
  agreementRef: string | null,
): string {
  const base = `${label}: ${formatPeriod(period)}`;
  return agreementRef ? `${base} (agreement ${agreementRef})` : base;
}

/**
 * The bucket month a settlement bills and the agreement in force now, read on
 * the scope's executor: the recorder's tenant transaction or a system one.
 */
async function settlementLineContext(
  row: GauSettlementRow,
  scope: GauSettlementScope,
): Promise<{ period: InvoicePeriod; agreementRef: string | null }> {
  return scope.run(async (tx) => {
    const buckets = await tx
      .select()
      .from(schema.gauBuckets)
      .where(eq(schema.gauBuckets.id, row.bucketId))
      .limit(1);
    const bucket = buckets[0];
    if (!bucket) {
      throw new Error(
        `billing: settlement ${row.id} names bucket ${row.bucketId}, which does not exist`,
      );
    }
    const { terms } = await readGauEntitlement(tx, row.orgId);
    return {
      period: { start: bucket.periodStart, end: bucket.periodEnd },
      agreementRef: terms.source === "negotiated" ? terms.agreementRef : null,
    };
  });
}

/**
 * Where a settlement sequence runs: the executor its writes commit on, the
 * Stripe customer the invoice is for, and the org's default card (null →
 * the invoice is emailed).
 */
export interface GauSettlementScope {
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  customerId: () => Promise<string>;
  defaultPaymentMethodId: () => Promise<string | null>;
}

/** The scope of a caller with no tenant: the job and the operator handler. */
function systemSettlementScope(orgId: string): GauSettlementScope {
  return {
    run: withSystemDb,
    customerId: () => ensureStripeCustomer(orgId, { system: true }),
    defaultPaymentMethodId: async () =>
      (await readDefaultPaymentMethod(orgId, { system: true }))
        ?.stripePaymentMethodId ?? null,
  };
}

async function createSettlementInvoice(
  row: GauSettlementRow,
  scope: GauSettlementScope,
): Promise<string> {
  const invoice = INVOICE_KINDS[row.kind];
  if (invoice === undefined) {
    throw new Error(`billing: a ${row.kind} settlement carries no invoice`);
  }
  const [customerId, paymentMethodId, line] = await Promise.all([
    scope.customerId(),
    scope.defaultPaymentMethodId(),
    settlementLineContext(row, scope),
  ]);
  const { invoiceId } = await billingProvider().createGauInvoice({
    customerId,
    orgId: row.orgId,
    settlementId: row.id,
    kind: invoice.kind,
    quantityGau: row.quantityGau,
    ratePerGauMicros: row.ratePerGauMicros,
    currency: row.currency,
    description: settlementLineDescription(
      invoice.label,
      line.period,
      line.agreementRef,
    ),
    period: line.period,
    collection:
      paymentMethodId === null
        ? { method: "send_invoice", daysUntilDue: GAU_INVOICE_DAYS_UNTIL_DUE }
        : {
            method: "charge_automatically",
            defaultPaymentMethodId: paymentMethodId,
          },
  });
  await scope.run((tx) => recordGauInvoice(tx, row.id, invoiceId));
  return invoiceId;
}

/**
 * Turn a committed `pending` settlement into a Stripe invoice and settle it
 * from Stripe's answer: `createGauInvoice` when the row holds no invoice id,
 * `recordGauInvoice` (committed), `finalizeAndPayGauInvoice`, then
 * `settleGauPaid` or `settleGauOpen`. A row that already holds an invoice id
 * goes straight to `finalizeAndPayGauInvoice`, which does only what is left.
 *
 * Never throws: a failure is logged and leaves the row `pending` — with no
 * invoice id when the create failed, with the id when finalizing did — for
 * the close job to resume. Returns the status the row was left in.
 */
export async function settleGauInvoice(
  row: GauSettlementRow,
  scope: GauSettlementScope,
): Promise<"paid" | "open" | "pending"> {
  const context = { settlementId: row.id, orgId: row.orgId, kind: row.kind };
  try {
    const invoiceId =
      row.stripeInvoiceId ?? (await createSettlementInvoice(row, scope));
    const payment = await billingProvider().finalizeAndPayGauInvoice({
      settlementId: row.id,
      invoiceId,
    });
    await scope.run((tx) =>
      payment.status === "paid"
        ? settleGauPaid(tx, row.id)
        : settleGauOpen(tx, row.id),
    );
    logger.info(
      { ...context, invoiceId, status: payment.status },
      "billing: gau settlement invoiced",
    );
    return payment.status;
  } catch (error) {
    logger.error(
      {
        ...context,
        err: error instanceof Error ? error.message : String(error),
      },
      "billing: gau settlement left pending for the close job",
    );
    return "pending";
  }
}

// ── The close job's steps (billing.gau-close) ───────────────────────────────

const GAU_JOB_PAGE_SIZE = 100;
const HOUR_MS = 60 * 60 * 1000;
/** How long Stripe keeps a request's result under its idempotency key. */
const IDEMPOTENCY_WINDOW_MS = 24 * HOUR_MS;

/** One keyset page of a job step: rows seen, and the cursor of the next page or null. */
export interface GauJobPage {
  processed: number;
  nextCursor: string | null;
}

function pageOf(rows: { id: string }[]): GauJobPage {
  return {
    processed: rows.length,
    nextCursor:
      rows.length === GAU_JOB_PAGE_SIZE ? (rows.at(-1)?.id ?? null) : null,
  };
}

async function closeGauPeriod(bucket: GauBucketRow, now: Date): Promise<void> {
  const settings = await readOrgBillingSettings(bucket.orgId, {
    system: true,
  });
  const quantity = uninvoicedGau(bucket);
  const unclosed = and(
    eq(schema.gauBuckets.id, bucket.id),
    isNull(schema.gauBuckets.closedAt),
  );
  if (!settings.approvedForInvoiceBilling || quantity === 0) {
    await withSystemDb((tx) =>
      tx
        .update(schema.gauBuckets)
        .set({ closedAt: sql`now()`, updatedAt: sql`now()` })
        .where(unclosed),
    );
    return;
  }
  const claimed = await withSystemDb(async (tx) => {
    const { terms } = await readGauEntitlement(tx, bucket.orgId, now);
    const closed = await tx
      .update(schema.gauBuckets)
      .set({
        closedAt: sql`now()`,
        overageInvoicedGau: sql`${schema.gauBuckets.overageInvoicedGau} + ${quantity}`,
        updatedAt: sql`now()`,
      })
      .where(unclosed)
      .returning({ id: schema.gauBuckets.id });
    if (closed.length === 0) return null;
    return insertPendingSettlement(tx, {
      id: crypto.randomUUID(),
      bucket,
      kind: "period_close",
      seq: 0,
      quantityGau: quantity,
      terms,
    });
  });
  if (claimed !== null) {
    await settleGauInvoice(claimed, systemSettlementScope(bucket.orgId));
  }
}

/**
 * Close the org's invoice-billing accrual. `set_org_billing_terms` calls it
 * before it switches invoice billing off, so no overage is stranded between
 * the modes (item 12). First every bucket whose month has ended and that the
 * close job has not closed yet is closed the way the job closes it, while the
 * org is still invoice-billed: its uninvoiced overage becomes a `period_close`
 * settlement. Then every uninvoiced GAU of the current bucket is claimed as
 * one interim settlement and the settlement sequence runs. Returns the
 * current bucket's claimed row, or null when nothing was uninvoiced there.
 */
export async function closeInvoiceAccrual(
  orgId: string,
  now: Date = new Date(),
): Promise<GauSettlementRow | null> {
  // The hourly close job leaves an org at most a few ended, unclosed months,
  // so one page holds them all.
  const ended = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.gauBuckets)
      .where(
        and(
          eq(schema.gauBuckets.orgId, orgId),
          lte(schema.gauBuckets.periodEnd, now),
          isNull(schema.gauBuckets.closedAt),
        ),
      )
      .orderBy(asc(schema.gauBuckets.periodStart))
      .limit(GAU_JOB_PAGE_SIZE),
  );
  for (const bucket of ended) {
    await closeGauPeriod(bucket, now);
  }

  const claimed = await withSystemDb(async (tx) => {
    const { terms, subscription } = await readGauEntitlement(tx, orgId, now);
    const period = periodFor(subscription, now);
    const buckets = await tx
      .select()
      .from(schema.gauBuckets)
      .where(
        and(
          eq(schema.gauBuckets.orgId, orgId),
          eq(schema.gauBuckets.periodStart, period.start),
        ),
      )
      .limit(1);
    const bucket = buckets[0];
    if (bucket === undefined) return null;
    const quantity = uninvoicedGau(bucket);
    return quantity > 0
      ? claimInterimInvoice(tx, bucket, terms, quantity)
      : null;
  });
  if (claimed !== null) {
    await settleGauInvoice(claimed, systemSettlementScope(orgId));
  }
  return claimed;
}

/**
 * Step 1: close every bucket whose month has ended. An invoice-billed month
 * with uninvoiced overage claims it as one `period_close` settlement (seq 0)
 * with `closed_at`, commits, and runs the settlement sequence; every other
 * month gets `closed_at` only. Keyset-paged on the bucket id.
 */
export async function closeEndedGauPeriods(
  cursor: string | null,
  now: Date = new Date(),
): Promise<GauJobPage> {
  const buckets = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.gauBuckets)
      .where(
        and(
          lte(schema.gauBuckets.periodEnd, now),
          isNull(schema.gauBuckets.closedAt),
          cursor === null ? undefined : gt(schema.gauBuckets.id, cursor),
        ),
      )
      .orderBy(asc(schema.gauBuckets.id))
      .limit(GAU_JOB_PAGE_SIZE),
  );
  for (const bucket of buckets) {
    try {
      await closeGauPeriod(bucket, now);
    } catch (error) {
      logger.error(
        {
          bucketId: bucket.id,
          orgId: bucket.orgId,
          err: error instanceof Error ? error.message : String(error),
        },
        "billing: gau period close failed; the next run retries it",
      );
    }
  }
  return pageOf(buckets);
}

async function resumeSettlement(
  row: GauSettlementRow,
  now: Date,
): Promise<void> {
  const context = { settlementId: row.id, orgId: row.orgId, kind: row.kind };

  if (row.kind === "auto_topup") {
    const buckets = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.gauBuckets)
        .where(eq(schema.gauBuckets.id, row.bucketId))
        .limit(1),
    );
    const bucket = buckets[0];
    if (bucket !== undefined && remainingGau(bucket) > 0) {
      // A Checkout landed in between: the top-up is owed nothing, and a
      // draft it left behind is removed so nobody can finalize it later.
      let outcome: string | null = null;
      if (row.stripeInvoiceId !== null) {
        ({ outcome } = await billingProvider().deleteOrVoidDraftInvoice({
          settlementId: row.id,
          invoiceId: row.stripeInvoiceId,
        }));
      }
      if (outcome === "paid") {
        await withSystemDb((tx) => settleGauPaid(tx, row.id, now));
        logger.info(
          context,
          "billing: superseded gau auto top-up was already paid; settled paid",
        );
        return;
      }
      await withSystemDb((tx) => settleGauFailed(tx, row.id));
      logger.warn(
        { ...context, reason: "superseded", invoiceOutcome: outcome },
        "billing: gau auto top-up superseded by a purchase; marked failed",
      );
      return;
    }
  }

  if (
    row.stripeInvoiceId === null &&
    now.getTime() - row.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS
  ) {
    await withSystemDb((tx) => settleGauFailed(tx, row.id));
    logger.error(
      {
        ...context,
        alert: "billing_gau_settlement_stale",
        reason: "idempotency_key_expired",
      },
      "billing: gau settlement never reached Stripe inside the idempotency window; marked failed",
    );
    return;
  }

  await settleGauInvoice(row, systemSettlementScope(row.orgId));
}

/**
 * Step 2: resume every `pending` settlement older than an hour, from
 * Stripe's own state (item 10). Keyset-paged on the settlement id.
 */
export async function resumePendingGauSettlements(
  cursor: string | null,
  now: Date = new Date(),
): Promise<GauJobPage> {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.gauSettlements)
      .where(
        and(
          eq(schema.gauSettlements.status, "pending"),
          lt(
            schema.gauSettlements.createdAt,
            new Date(now.getTime() - HOUR_MS),
          ),
          cursor === null ? undefined : gt(schema.gauSettlements.id, cursor),
        ),
      )
      .orderBy(asc(schema.gauSettlements.id))
      .limit(GAU_JOB_PAGE_SIZE),
  );
  for (const row of rows) {
    try {
      await resumeSettlement(row, now);
    } catch (error) {
      logger.error(
        {
          settlementId: row.id,
          orgId: row.orgId,
          err: error instanceof Error ? error.message : String(error),
        },
        "billing: gau settlement resume failed; the next run retries it",
      );
    }
  }
  return pageOf(rows);
}

// ── The Checkout grant ──────────────────────────────────────────────────────

/** What a `gau_purchase` Checkout Session says it sold, from its metadata. */
interface GauPurchase {
  orgId: string;
  quantityGau: number;
  ratePerGauMicros: bigint;
  currency: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The purchase the session metadata describes. The session is self-sufficient
 * (the handler inserts nothing pending), so the metadata is the only record
 * of what was sold. A session that claims to be a GAU purchase without
 * saying what it sold is refused: the webhook records the error for an
 * operator to read, and no purchase is dropped or granted at a figure nobody
 * set.
 */
function parseGauPurchase(session: BillingCheckoutSession): GauPurchase {
  const m = session.metadata;
  const quantityGau = Number(m.gau_quantity);
  const blockSizeGau = Number(m.block_size_gau);
  const orgId = m.org_id ?? "";
  if (
    !UUID_RE.test(orgId) ||
    !Number.isInteger(quantityGau) ||
    quantityGau <= 0 ||
    !Number.isInteger(blockSizeGau) ||
    blockSizeGau <= 0 ||
    quantityGau % blockSizeGau !== 0 ||
    !/^\d+$/.test(m.rate_per_gau_micros ?? "") ||
    !/^[a-z]{3}$/.test(m.currency ?? "")
  ) {
    throw new Error(
      `billing: gau_purchase session ${session.id} carries no valid purchase metadata`,
    );
  }
  return {
    orgId,
    quantityGau,
    ratePerGauMicros: BigInt(m.rate_per_gau_micros!),
    currency: m.currency!,
  };
}

/**
 * The webhook grant for a paid `gau_purchase` Checkout Session (ADR-055 §6,
 * ARCHITECTURE.md §3.9 item 11): an upsert keyed on the session id.
 *
 * In one `withSystemDb` transaction: the org's current bucket through the
 * lazy create (its row lock serialises two deliveries of one session), the
 * `checkout` settlement inserted already `paid` with the session's invoice —
 * `ON CONFLICT (stripe_checkout_session_id) WHERE … IS NOT NULL DO NOTHING`,
 * so a second delivery inserts nothing and grants nothing — then the quantity
 * added to the bucket's `purchased_gau` and the bucket's open auto top-up
 * episode cleared (the close job marks that pending row superseded).
 *
 * After the commit, the card Checkout collected is saved: it becomes the
 * customer's default when the customer had none, and the
 * `billing.payment_methods` mirror row is upserted with `is_default` taken
 * from the provider's default after this step. The step runs on every
 * delivery, so a redelivery after a provider or database failure here still
 * saves the card and still marks it default. A Free org's first purchase
 * therefore leaves it with a default card, and its next exhaustion takes the
 * auto top-up path (ADR-055 §6).
 *
 * An unpaid session (`payment_status` other than `paid`) grants nothing:
 * Stripe fires `checkout.session.completed` for an async payment method
 * before the funds arrive.
 */
export async function grantGauPurchaseForCheckout(
  session: BillingCheckoutSession,
): Promise<void> {
  if (session.paymentStatus !== "paid") {
    logger.info(
      { sessionId: session.id, paymentStatus: session.paymentStatus },
      "billing: gau purchase session completed but not paid — no grant",
    );
    return;
  }
  const purchase = parseGauPurchase(session);
  const now = new Date();

  const granted = await withSystemDb(async (tx) => {
    // Before anything is read. A concurrent charge.refunded for this same
    // PaymentIntent waits here, so the two transactions cannot each miss the
    // other's uncommitted row and both commit — the write skew that leaves a
    // purchase spendable and its reversal pending for ever (ADR-085 §5).
    // reconcilePendingGauReversals takes the same lock, which is re-entrant
    // within a transaction; holding it from the top removes the need to reason
    // about the window between the settlement INSERT and that call.
    if (session.paymentIntentId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gau_purchase:${session.paymentIntentId}`}::text, 0))`,
      );
    }
    const { terms, subscription } = await readGauEntitlement(
      tx,
      purchase.orgId,
      now,
    );
    const period = periodFor(subscription, now);
    const bucket = await ensureCurrentBucket(tx, purchase.orgId, {
      period,
      terms,
      usedDelta: 0,
      purchasedDelta: 0,
    });
    const inserted = await tx
      .insert(schema.gauSettlements)
      .values({
        orgId: purchase.orgId,
        bucketId: bucket.id,
        kind: "checkout",
        seq: null,
        quantityGau: purchase.quantityGau,
        ratePerGauMicros: purchase.ratePerGauMicros,
        currency: purchase.currency,
        status: "paid",
        stripeCheckoutSessionId: session.id,
        stripeInvoiceId: session.invoiceId,
        // The purchase's payment identity, recorded here because a later
        // charge.refunded or charge.dispute.created names the PaymentIntent
        // and nothing else reaches back to this row (ADR-085).
        stripePaymentIntentId: session.paymentIntentId,
        // Tax included: the denominator a partial reversal prorates against.
        chargedCents: session.amountTotalCents,
        settledAt: now,
      })
      .onConflictDoNothing({
        target: schema.gauSettlements.stripeCheckoutSessionId,
        // The unique index is partial; the arbiter must restate its predicate.
        where: sql`${schema.gauSettlements.stripeCheckoutSessionId} IS NOT NULL`,
      })
      .returning({ id: schema.gauSettlements.id });
    if (inserted.length === 0) return false;

    // The grant itself. Its return value is no longer read: reconciliation
    // resolves and re-locks the bucket for each debit rather than being handed
    // this snapshot, so passing it on would be handing over exactly the stale
    // counts that caused the round-six defect.
    await ensureCurrentBucket(tx, purchase.orgId, {
      period,
      terms,
      usedDelta: 0,
      purchasedDelta: purchase.quantityGau,
    });
    await tx
      .update(schema.gauBuckets)
      .set({ openTopupSettlementId: null, updatedAt: sql`now()` })
      .where(eq(schema.gauBuckets.id, bucket.id));

    // The money for this purchase may already have come back: Stripe does not
    // order webhook deliveries, and a grant that failed once is retried later,
    // so `charge.refunded` can be processed first. It parks a pending reversal
    // against this PaymentIntent rather than dropping it; settle it here, in
    // this transaction, so the units are never spendable in between (ADR-085).
    //
    // Reached only on the delivery that actually inserted the settlement — a
    // redelivery returns above — and the lookup matches only rows still
    // pending, so it cannot withdraw twice.
    const reconciled = await reconcilePendingGauReversals(tx, {
      settlement: {
        id: inserted[0]!.id,
        orgId: purchase.orgId,
        quantityGau: purchase.quantityGau,
        ratePerGauMicros: purchase.ratePerGauMicros,
        chargedCents: session.amountTotalCents,
      },
      paymentIntentId: session.paymentIntentId,
      now,
    });
    if (reconciled.length > 0) {
      logger.warn(
        {
          orgId: purchase.orgId,
          sessionId: session.id,
          paymentIntentId: session.paymentIntentId,
          quantityGau: purchase.quantityGau,
          reversals: reconciled.length,
          reversedGau: reconciled.reduce((n, r) => n + r.reversedGau, 0),
        },
        "billing: gau purchase granted against a refund that arrived first — units withdrawn in the same transaction",
      );
    }
    return true;
  });

  logger.info(
    {
      orgId: purchase.orgId,
      sessionId: session.id,
      invoiceId: session.invoiceId,
      quantityGau: purchase.quantityGau,
      granted,
    },
    granted
      ? "billing: gau purchase granted"
      : "billing: gau purchase already granted for this session, skipping",
  );

  await saveCheckoutCard(session, purchase.orgId);
}

/**
 * Save the card a paid Checkout collected (`setup_future_usage:
 * "off_session"` attached it to the customer): the customer default when
 * none is set, and the mirror row with `is_default` equal to whether the
 * card is the provider's default once this step has run. The flag comes
 * from the provider's answer rather than from whether this run set it, so a
 * redelivery after the Stripe update committed and the mirror write failed
 * still lands `is_default = true`.
 */
async function saveCheckoutCard(
  session: BillingCheckoutSession,
  orgId: string,
): Promise<void> {
  const customerId = session.customerId;
  if (customerId === null) return;
  const provider = billingProvider();
  const pm = await provider.getCheckoutPaymentMethod(session.id);
  if (pm === null) return;

  const existingDefault = await provider.getDefaultPaymentMethodId(customerId);
  const madeDefault = existingDefault === null;
  if (madeDefault) await provider.setDefaultPaymentMethod(customerId, pm.id);
  const isDefault = madeDefault || existingDefault === pm.id;

  await withSystemDb(async (tx) => {
    if (isDefault) {
      await tx
        .update(schema.paymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.paymentMethods.orgId, orgId),
            eq(schema.paymentMethods.isDefault, true),
          ),
        );
    }
    await tx
      .insert(schema.paymentMethods)
      .values({
        orgId,
        stripeCustomerId: customerId,
        stripePaymentMethodId: pm.id,
        type: pm.type,
        brand: pm.brand,
        last4: pm.last4,
        expMonth: pm.expMonth,
        expYear: pm.expYear,
        isDefault,
      })
      .onConflictDoUpdate({
        target: schema.paymentMethods.stripePaymentMethodId,
        set: {
          brand: pm.brand,
          last4: pm.last4,
          expMonth: pm.expMonth,
          expYear: pm.expYear,
          deletedAt: null,
          deletedById: null,
          updatedAt: new Date(),
          ...(isDefault ? { isDefault: true } : {}),
        },
      });
  });

  logger.info(
    { orgId, sessionId: session.id, paymentMethodId: pm.id, isDefault },
    "billing: checkout card saved",
  );
}
