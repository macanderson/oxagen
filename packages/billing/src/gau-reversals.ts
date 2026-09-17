// tenancy: system bypass via withSystemDb throughout. A `charge.refunded` or
// `charge.dispute.created` webhook arrives with Stripe ids and no tenant
// scope; the organisation is read off the settlement the PaymentIntent names,
// which is the same bypass `grantGauPurchaseForCheckout` runs the grant under.
// billing is org_only, no workspace_id.
import { and, eq, sql } from "drizzle-orm";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { readGauEntitlement } from "./contract-terms";
import { ensureCurrentBucket, periodFor } from "./gau-bucket";
import { logger } from "./logger";
import type { BillingDispute, BillingRefundedCharge } from "./provider";

/** Micro-dollars in one cent, as `blockPriceCents` uses them. */
const MICROS_PER_CENT = 10_000n;

type GauSettlementRow = typeof schema.gauSettlements.$inferSelect;

/** What a reversal did, for the caller's log line and for tests. */
export interface GauReversalResult {
  orgId: string;
  settlementId: string;
  /** The bucket that was debited: the org's bucket for the current period. */
  bucketId: string;
  /** Units the money reversal is worth (pro-rata on a partial refund). */
  requestedGau: number;
  /** Units actually taken out of the bucket. */
  reversedGau: number;
  /** Units the customer already spent, or that rolled past the live balance. */
  unrecoveredGau: number;
  /** False when a redelivery found the reversal already recorded. */
  applied: boolean;
}

/**
 * The GAU purchase a refund or a dispute is against, or null.
 *
 * The PaymentIntent is the only link. A Stripe Charge carries the
 * PaymentIntent's metadata, so a refund could also be matched on
 * `metadata.org_id` — but a Stripe Dispute carries its own metadata, which
 * nothing sets, so metadata alone resolves half the cases. The settlement
 * records the PaymentIntent at grant time and both events name it (ADR-085).
 *
 * `checkout` is the only kind matched: an `auto_topup`, `interim_invoice` or
 * `period_close` settlement is charged through an Invoice, and a refund of one
 * is an invoicing correction rather than a purchase to unwind.
 */
async function findPurchaseByPaymentIntent(
  tx: Tx,
  paymentIntentId: string | null,
): Promise<GauSettlementRow | null> {
  if (!paymentIntentId) return null;
  const row = await tx.query.gauSettlements.findFirst({
    where: and(
      eq(schema.gauSettlements.stripePaymentIntentId, paymentIntentId),
      eq(schema.gauSettlements.kind, "checkout"),
    ),
  });
  return row ?? null;
}

/**
 * The units a money reversal of `amountCents` is worth against `settlement`.
 *
 * The settlement's gross is exact in cents: `blockPriceCents` refuses terms
 * whose `rate_per_gau_micros * block_size_gau` is not a whole number of cents,
 * and a purchase is a whole number of blocks, so `quantity * rate / 10000`
 * reconstructs what was charged before tax.
 *
 * A reversal at or above that gross takes every unit — tax makes the amount
 * refunded exceed the gross in the ordinary full-refund case, so this is the
 * common branch, not an edge. Below it the reversal is partial and the units
 * come out pro-rata, rounded down: a partial refund should never withdraw more
 * than it paid back.
 */
export function reversibleGau(
  settlement: Pick<GauSettlementRow, "quantityGau" | "ratePerGauMicros">,
  amountCents: number,
): number {
  if (amountCents <= 0) return 0;
  const grossCents =
    (BigInt(settlement.quantityGau) * settlement.ratePerGauMicros) /
    MICROS_PER_CENT;
  if (grossCents <= 0n) return settlement.quantityGau;
  if (BigInt(amountCents) >= grossCents) return settlement.quantityGau;
  return Number(
    (BigInt(settlement.quantityGau) * BigInt(amountCents)) / grossCents,
  );
}

interface ApplyGauReversalArgs {
  kind: "refund" | "dispute";
  /** `ch_…` for a refund, `dp_…` for a dispute: half the idempotency key. */
  providerEventId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
}

/**
 * Withdraw the units a refunded or disputed GAU block purchase granted.
 *
 * Returns null when the event is not against a GAU purchase, which is the
 * caller's signal to fall through to the usage-credit clawback.
 *
 * Which bucket is debited (ADR-085): the org's bucket for the period the
 * reversal is processed in, not the bucket the grant landed on. Only the
 * current bucket's balance is read by the gate, and the rollover folds last
 * month's `purchased` and `carried` into this month's `carried` rather than
 * moving anything — so debiting the grant's own bucket after a month boundary
 * would leave every refunded unit spendable.
 *
 * Where the units come from, in order: `purchased_gau`, then `carried_gau`.
 * That is the order bought units are held in across a rollover. Both are
 * clamped at zero — `gau_buckets_counts_non_negative` refuses a negative
 * count, so a reversal that tried to drive one below zero would not fail
 * safely, it would fail the whole webhook.
 *
 * What is left over — units the customer already spent, or that rolled past
 * the live balance — is recorded as `unrecovered_gau` and not pursued. It is
 * not written off silently: removing the purchased units lowers `remaining`
 * (which may go negative) and raises uninvoiced overage by the same amount, so
 * an invoice-billed org is billed for what it consumed and a prepaid org is
 * blocked until it buys again. The row states the figure either way.
 */
export async function applyGauReversal(
  args: ApplyGauReversalArgs,
): Promise<GauReversalResult | null> {
  const now = new Date();

  const result = await withSystemDb(async (tx) => {
    const settlement = await findPurchaseByPaymentIntent(
      tx,
      args.paymentIntentId,
    );
    if (!settlement) return null;

    // Idempotency: Stripe redelivers. Keyed on (settlement, provider event) by
    // `gau_reversals_settlement_event_idx`, the same shape the credit clawback
    // keys its ledger row on. A second delivery of one charge or one dispute
    // reads this row and withdraws nothing.
    const existing = await tx.query.gauReversals.findFirst({
      where: and(
        eq(schema.gauReversals.settlementId, settlement.id),
        eq(schema.gauReversals.providerEventId, args.providerEventId),
      ),
    });
    if (existing) {
      return {
        orgId: existing.orgId,
        settlementId: existing.settlementId,
        bucketId: existing.bucketId,
        requestedGau: existing.requestedGau,
        reversedGau: existing.reversedGau,
        unrecoveredGau: existing.unrecoveredGau,
        applied: false,
      } satisfies GauReversalResult;
    }

    const requestedGau = reversibleGau(settlement, args.amountCents);

    // Materialise the current bucket the way the grant does, so an org whose
    // month has rolled with no activity still has the row its carried units
    // are on before they are taken off it.
    const { terms, subscription } = await readGauEntitlement(
      tx,
      settlement.orgId,
      now,
    );
    const bucket = await ensureCurrentBucket(tx, settlement.orgId, {
      period: periodFor(subscription, now),
      terms,
      usedDelta: 0,
      purchasedDelta: 0,
    });

    const fromPurchased = Math.min(bucket.purchasedGau, requestedGau);
    const fromCarried = Math.min(
      bucket.carriedGau,
      requestedGau - fromPurchased,
    );
    const reversedGau = fromPurchased + fromCarried;
    const unrecoveredGau = requestedGau - reversedGau;

    if (reversedGau > 0) {
      await tx
        .update(schema.gauBuckets)
        .set({
          purchasedGau: bucket.purchasedGau - fromPurchased,
          carriedGau: bucket.carriedGau - fromCarried,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.gauBuckets.id, bucket.id));
    }

    await tx.insert(schema.gauReversals).values({
      orgId: settlement.orgId,
      settlementId: settlement.id,
      bucketId: bucket.id,
      kind: args.kind,
      providerEventId: args.providerEventId,
      requestedGau,
      reversedGau,
      unrecoveredGau,
      amountCents: args.amountCents,
      currency: args.currency,
    });

    return {
      orgId: settlement.orgId,
      settlementId: settlement.id,
      bucketId: bucket.id,
      requestedGau,
      reversedGau,
      unrecoveredGau,
      applied: true,
    } satisfies GauReversalResult;
  });

  if (result === null) return null;

  const line = {
    orgId: result.orgId,
    kind: args.kind,
    providerEventId: args.providerEventId,
    settlementId: result.settlementId,
    bucketId: result.bucketId,
    amountCents: args.amountCents,
    requestedGau: result.requestedGau,
    reversedGau: result.reversedGau,
    unrecoveredGau: result.unrecoveredGau,
  };
  if (!result.applied) {
    logger.debug(line, "billing: gau reversal already applied, skipping");
  } else if (result.unrecoveredGau > 0) {
    // Not an error: the customer spent what they bought before asking for the
    // money back. Logged at warn because it is the figure an operator would
    // want to see without querying for it.
    logger.warn(
      line,
      "billing: gau purchase reversed — some units were already spent and were not recovered",
    );
  } else {
    logger.info(line, "billing: gau purchase reversed");
  }
  return result;
}

/**
 * `charge.refunded` against a GAU block purchase. Returns null when the charge
 * is not one, so the caller claws back usage credits instead.
 *
 * `amountRefundedCents` is cumulative on the charge, and the idempotency key is
 * the charge id, matching `onChargeRefunded`'s credit clawback: a second
 * partial refund on one charge redelivers the same charge id and is therefore
 * treated as a redelivery rather than as further units to withdraw. A GAU
 * purchase is sold in indivisible blocks and the product offers no partial
 * refund, so this is a deliberate consequence of matching the existing key
 * rather than an oversight (ADR-085).
 */
export async function reverseGauPurchaseForRefund(
  charge: BillingRefundedCharge,
): Promise<GauReversalResult | null> {
  return applyGauReversal({
    kind: "refund",
    providerEventId: charge.id,
    paymentIntentId: charge.paymentIntentId,
    amountCents: charge.amountRefundedCents,
    currency: charge.currency,
  });
}

/**
 * `charge.dispute.created` against a GAU block purchase. Returns null when the
 * dispute is not against one.
 *
 * The units go the moment the dispute opens, on the same reasoning the credit
 * clawback takes: the funds are withheld from the moment of the dispute. A
 * dispute the org wins is a manual re-grant, as a won dispute's credits are
 * today — `dispute.closed` records the outcome and reverses nothing.
 */
export async function reverseGauPurchaseForDispute(
  dispute: BillingDispute,
): Promise<GauReversalResult | null> {
  return applyGauReversal({
    kind: "dispute",
    providerEventId: dispute.id,
    paymentIntentId: dispute.paymentIntentId,
    amountCents: dispute.amountCents,
    currency: dispute.currency,
  });
}
