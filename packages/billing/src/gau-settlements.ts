/**
 * gau-settlements.ts — the settlement ledger's writers (ADR-055 §6,
 * apps/app/ARCHITECTURE.md §3.9 items 7, 8c and 11).
 *
 * Every writer takes its executor first, the shape `tryInsertGrantLedger(tx,
 * …)` has: the recorder passes a `withTenantDb` transaction, the webhooks and
 * the close job a `withSystemDb` one. The one entry point that opens its own
 * transaction is `grantGauPurchaseForCheckout`, the webhook grant, which is
 * the whole of what a paid Checkout does.
 */

// tenancy: system bypass via withSystemDb in grantGauPurchaseForCheckout (the
// checkout.session.completed webhook: the org comes from the session metadata
// and no tenant scope is active; withTenantDb there throws TenantScopeError
// under enforced RLS).

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { billingProvider } from "./client";
import { readGauEntitlement } from "./contract-terms";
import {
  ensureCurrentBucket,
  gauRemainingSql,
  periodFor,
  type GauBucketRow,
} from "./gau-bucket";
import { logger } from "./logger";
import type { GauTerms } from "./pricing";
import type { BillingCheckoutSession } from "./provider";

export type GauSettlementRow = typeof schema.gauSettlements.$inferSelect;

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
 * inserted in the same transaction, `pending`, with the terms' rate and
 * currency recorded at claim time (`quantity_gau = blocks × block_size_gau`).
 * The caller commits before its first provider call, so a crash after the
 * commit leaves a `pending` row a job can resume rather than a paid invoice
 * nothing remembers.
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

  const rows = await tx
    .insert(schema.gauSettlements)
    .values({
      id: settlementId,
      orgId: bucket.orgId,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq,
      quantityGau: Math.max(1, Math.floor(blocks)) * terms.blockSizeGau,
      ratePerGauMicros: terms.ratePerGauMicros,
      currency: terms.currency,
      status: "pending",
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("billing: gau_settlements insert returned no row");
  }
  return row;
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
 * `billing.payment_methods` mirror row is upserted with `is_default` set
 * accordingly. This step runs on every delivery, so a redelivery after a
 * provider failure here still saves the card. A Free org's first purchase
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
        settledAt: now,
      })
      .onConflictDoNothing({
        target: schema.gauSettlements.stripeCheckoutSessionId,
        // The unique index is partial; the arbiter must restate its predicate.
        where: sql`${schema.gauSettlements.stripeCheckoutSessionId} IS NOT NULL`,
      })
      .returning({ id: schema.gauSettlements.id });
    if (inserted.length === 0) return false;

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
 * none is set, and the mirror row with `is_default` to match. Idempotent:
 * on a redelivery the customer already has the default and the upsert only
 * refreshes the card details.
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

  const madeDefault =
    (await provider.getDefaultPaymentMethodId(customerId)) === null;
  if (madeDefault) await provider.setDefaultPaymentMethod(customerId, pm.id);

  await withSystemDb(async (tx) => {
    if (madeDefault) {
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
        isDefault: madeDefault,
      })
      .onConflictDoUpdate({
        target: schema.paymentMethods.stripePaymentMethodId,
        set: {
          brand: pm.brand,
          last4: pm.last4,
          expMonth: pm.expMonth,
          expYear: pm.expYear,
          deletedAt: null,
          deletedByUserId: null,
          updatedAt: new Date(),
          ...(madeDefault ? { isDefault: true } : {}),
        },
      });
  });

  logger.info(
    { orgId, sessionId: session.id, paymentMethodId: pm.id, madeDefault },
    "billing: checkout card saved",
  );
}
