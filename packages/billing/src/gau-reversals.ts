// tenancy: system bypass via withSystemDb throughout. A `charge.refunded` or
// `charge.dispute.created` webhook arrives with Stripe ids and no tenant
// scope; the organisation is read off the settlement the PaymentIntent names,
// which is the same bypass `grantGauPurchaseForCheckout` runs the grant under.
// billing is org_only, no workspace_id.
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { billingProvider } from "./client";
import { readGauEntitlement } from "./contract-terms";
import { ensureCurrentBucket, periodFor } from "./gau-bucket";
import { logger } from "./logger";
import type { BillingDispute, BillingRefundedCharge } from "./provider";

/** Micro-dollars in one cent, as `blockPriceCents` uses them. */
const MICROS_PER_CENT = 10_000n;

/**
 * Serialise everything that decides about one purchase's money, keyed on the
 * PaymentIntent, for the life of the caller's transaction.
 *
 * Without it the grant and a refund race, and the race is a *write skew* that
 * no amount of care inside either transaction can see: under READ COMMITTED
 * the refund looks for a settlement and misses the grant's uncommitted INSERT,
 * so it parks a pending row; the grant looks for pending rows and misses the
 * refund's uncommitted INSERT, so it reconciles nothing. Both commit. The
 * purchase stays spendable and the reversal stays pending for ever, because a
 * checkout redelivery stops at the settlement that now exists and never
 * reaches reconciliation again.
 *
 * The bucket's row lock does not help: it orders a grant against another
 * grant, and these two transactions write different tables. The invariant has
 * to be one that two concurrent transactions cannot both satisfy, which means
 * a lock they both take before deciding. `processStripeEvent` dispatches
 * deliveries concurrently by design, so this is reachable in normal operation
 * rather than under load.
 *
 * Same idiom as `bind_main_repository` in repository.main.bind.ts: an
 * xact-scoped advisory lock over a namespaced string, released on commit or
 * rollback with no unlock path to forget.
 */
async function lockPurchaseByPaymentIntent(
  tx: Tx,
  paymentIntentId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gau_purchase:${paymentIntentId}`}::text, 0))`,
  );
}

type GauSettlementRow = typeof schema.gauSettlements.$inferSelect;

/** What a reversal did, for the caller's log line and for tests. */
export interface GauReversalResult {
  /**
   * True when the money came back before the purchase was recorded. Nothing
   * was withdrawn yet — the row is parked against the PaymentIntent and the
   * grant reconciles it before it hands out spendable units.
   */
  pending: boolean;
  orgId: string | null;
  settlementId: string | null;
  /** The bucket that was debited, or null while pending. */
  bucketId: string | null;
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
 * The denominator is what the customer actually paid, tax included
 * (`charged_cents`, recorded from the Checkout Session's `amount_total`).
 * Stripe's `amount_refunded` includes refunded tax, so prorating against the
 * pre-tax subtotal over-withdraws by exactly the tax rate: half of a 5,500c
 * tax-inclusive charge is 2,750c, which against a 5,000c subtotal reads as 55%
 * of the units instead of 50%. The error is invisible on a full refund, because
 * the amount then exceeds the subtotal and saturates at the whole quantity.
 *
 * The subtotal is the fallback for a settlement recorded before `charged_cents`
 * existed. It is exact in cents — `blockPriceCents` refuses terms whose
 * `rate_per_gau_micros * block_size_gau` is not a whole number of cents, and a
 * purchase is a whole number of blocks.
 *
 * At or above the denominator every unit goes. Below it the reversal is partial
 * and the units come out pro-rata, rounded down: a partial refund never
 * withdraws more than it paid back.
 */
export function reversibleGau(
  settlement: Pick<
    GauSettlementRow,
    "quantityGau" | "ratePerGauMicros" | "chargedCents"
  >,
  amountCents: number,
): number {
  if (amountCents <= 0) return 0;
  const subtotalCents =
    (BigInt(settlement.quantityGau) * settlement.ratePerGauMicros) /
    MICROS_PER_CENT;
  const denominatorCents =
    settlement.chargedCents !== null && settlement.chargedCents > 0
      ? BigInt(settlement.chargedCents)
      : subtotalCents;
  if (denominatorCents <= 0n) return settlement.quantityGau;
  if (BigInt(amountCents) >= denominatorCents) return settlement.quantityGau;
  return Number(
    (BigInt(settlement.quantityGau) * BigInt(amountCents)) / denominatorCents,
  );
}

/**
 * Take `units` off the organisation's CURRENT bucket, and report what it got.
 *
 * Every single-debit reversal path goes through here, and that is the point.
 * Two properties are load-bearing and both come from `ensureCurrentBucket`:
 *
 *  1. **The bucket is resolved now, not remembered.** A stored `bucket_id` is a
 *     fact about when a row was written, not about where the units live today.
 *     After a period rollover the units a second refund must take are the
 *     CURRENT bucket's `carried_gau`; debiting the historical bucket leaves
 *     them spendable.
 *  2. **The upsert takes the bucket's row lock and holds it to commit**, which
 *     is what makes the absolute-valued UPDATE below correct. A plain SELECT
 *     reads the same numbers and then races a concurrent grant or auto top-up,
 *     whose relative increment this would then erase — and that grant holds a
 *     DIFFERENT advisory lock, because `gau_purchase:<payment_intent_id>`
 *     serialises reversals of one purchase against each other and says nothing
 *     about a purchase on another PaymentIntent touching the same bucket.
 *
 * Both were true of the first reversal path and neither survived being written
 * a second time for cumulative refunds, so there is now one implementation
 * rather than a rule to remember. Replacing this call with a read is not a
 * simplification.
 */
async function debitCurrentBucket(
  tx: Tx,
  args: { orgId: string; units: number; now: Date },
): Promise<{ bucketId: string; reversedGau: number }> {
  const { terms, subscription } = await readGauEntitlement(
    tx,
    args.orgId,
    args.now,
  );
  const bucket = await ensureCurrentBucket(tx, args.orgId, {
    period: periodFor(subscription, args.now),
    terms,
    usedDelta: 0,
    purchasedDelta: 0,
  });

  // Purchased before carried: the order bought units are held in across a
  // rollover. Both clamp at zero — `gau_buckets_counts_non_negative` refuses a
  // negative count, so an unclamped write fails the whole webhook.
  const units = Math.max(0, args.units);
  const fromPurchased = Math.min(bucket.purchasedGau, units);
  const fromCarried = Math.min(bucket.carriedGau, units - fromPurchased);
  const reversedGau = fromPurchased + fromCarried;

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
  return { bucketId: bucket.id, reversedGau };
}

type GauReversalRow = typeof schema.gauReversals.$inferSelect;

/**
 * The units of one purchase that reversal rows already claim.
 *
 * A purchase granted `quantity_gau` units and no set of reversal events
 * against it may withdraw more than that between them. Nothing else can
 * enforce it: a GAU bucket is ONE balance for the organisation, not a balance
 * per purchase, so a second event that prices itself against the settlement
 * from scratch takes units indiscriminately — and the ones still in the bucket
 * after the first event are, by definition, units some OTHER purchase paid
 * for. `debitCurrentBucket` cannot tell the difference and correctly refuses
 * to guess; the cap has to be applied before it is called.
 *
 * Summed over `requested_gau` rather than `reversed_gau`, because the question
 * is what the money entitled the reversal to take, not what the bucket
 * happened to have. A first event that found the bucket empty still consumed
 * the purchase's entitlement: its units were spent, and `unrecovered_gau`
 * records that they are not being pursued. Counting `reversed_gau` would let
 * that entitlement be claimed a second time, which is the same double debit by
 * a longer route.
 *
 * Scoped to the settlement, so a bucket shared by several purchases still
 * reverses each of them in full.
 */
async function requestedGauForSettlement(
  tx: Tx,
  settlementId: string,
  excludeReversalId?: string,
): Promise<number> {
  const rows = await tx
    .select()
    .from(schema.gauReversals)
    .where(eq(schema.gauReversals.settlementId, settlementId));
  let total = 0;
  for (const row of rows) {
    if (row.id === excludeReversalId) continue;
    total += row.requestedGau;
  }
  return total;
}

/**
 * What `amountCents` is worth against `settlement`, less what is already
 * claimed. Never negative: a purchase whose entitlement is used up yields 0,
 * which reports it as already reversed instead of debiting anything.
 */
function remainingReversibleGau(
  settlement: Pick<
    GauSettlementRow,
    "quantityGau" | "ratePerGauMicros" | "chargedCents"
  >,
  amountCents: number,
  alreadyRequestedGau: number,
): number {
  const remaining = Math.max(0, settlement.quantityGau - alreadyRequestedGau);
  return Math.min(reversibleGau(settlement, amountCents), remaining);
}

/**
 * A second partial refund on a charge this reversal already covers.
 *
 * The units are recomputed for the NEW cumulative total and the difference is
 * withdrawn, rather than prorating each delta on its own: proration floors, so
 * summing per-delta figures drifts below the total the customer was actually
 * refunded. Recomputing the whole and subtracting what is already recorded
 * keeps the row equal to one proration of the cumulative amount however many
 * deliveries built it.
 *
 * A row still pending has no settlement to price against, so it only records
 * the larger amount; reconciliation prorates the final total once.
 */
async function applyCumulativeIncrease(
  tx: Tx,
  args: {
    existing: GauReversalRow;
    amountCents: number;
    paymentIntentId: string;
    now: Date;
  },
): Promise<GauReversalResult> {
  const { existing } = args;

  if (existing.settlementId === null || existing.bucketId === null) {
    await tx
      .update(schema.gauReversals)
      .set({ amountCents: args.amountCents })
      .where(eq(schema.gauReversals.id, existing.id));
    return {
      pending: true,
      orgId: existing.orgId,
      settlementId: null,
      bucketId: null,
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      applied: true,
    };
  }

  const settlement = await findPurchaseByPaymentIntent(
    tx,
    args.paymentIntentId,
  );
  if (!settlement) {
    // The row claims a settlement that is not there. Nothing safe to price
    // against, so record the money and leave the units to an operator.
    logger.error(
      {
        reversalId: existing.id,
        settlementId: existing.settlementId,
        paymentIntentId: args.paymentIntentId,
      },
      "billing: gau reversal references a settlement that cannot be read; units not adjusted",
    );
    await tx
      .update(schema.gauReversals)
      .set({ amountCents: args.amountCents })
      .where(eq(schema.gauReversals.id, existing.id));
    return {
      pending: false,
      orgId: existing.orgId,
      settlementId: existing.settlementId,
      bucketId: existing.bucketId,
      requestedGau: existing.requestedGau,
      reversedGau: existing.reversedGau,
      unrecoveredGau: existing.unrecoveredGau,
      applied: false,
    };
  }

  // Every row for this settlement EXCEPT this one: the cumulative total
  // recomputed here replaces this row's own claim rather than adding to it.
  const claimedElsewhere = await requestedGauForSettlement(
    tx,
    settlement.id,
    existing.id,
  );
  const totalRequestedGau = remainingReversibleGau(
    settlement,
    args.amountCents,
    claimedElsewhere,
  );
  const deltaGau = Math.max(0, totalRequestedGau - existing.requestedGau);

  // The current bucket, NOT `existing.bucketId`. That id records where the
  // first refund took its units; after a rollover the units this one must take
  // are the current bucket's carried balance, and debiting the historical row
  // would leave them spendable.
  const { bucketId, reversedGau: newlyReversed } = await debitCurrentBucket(
    tx,
    { orgId: settlement.orgId, units: deltaGau, now: args.now },
  );

  const reversedGau = existing.reversedGau + newlyReversed;
  await tx
    .update(schema.gauReversals)
    .set({
      amountCents: args.amountCents,
      // The row points at the bucket it most recently took from, so a reader
      // lands on where the units actually went.
      bucketId,
      requestedGau: totalRequestedGau,
      reversedGau,
      unrecoveredGau: totalRequestedGau - reversedGau,
    })
    .where(eq(schema.gauReversals.id, existing.id));

  return {
    pending: false,
    orgId: existing.orgId,
    settlementId: existing.settlementId,
    bucketId,
    requestedGau: totalRequestedGau,
    reversedGau,
    unrecoveredGau: totalRequestedGau - reversedGau,
    applied: true,
  };
}

interface ApplyGauReversalArgs {
  kind: "refund" | "dispute";
  /** `ch_…` for a refund, `dp_…` for a dispute: half the idempotency key. */
  providerEventId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  /**
   * Set when the provider event itself says it was a GAU block purchase
   * (`metadata.oxagen_kind`), which only a charge carries. With it, a reversal
   * that finds no settlement is parked as pending instead of being handed on
   * to the usage-credit clawback; without it, an unmatched event is simply not
   * ours. `orgId` comes from the same metadata and is what the pending row is
   * attributed to, since there is no settlement to read it from.
   */
  gauPurchaseOrgId?: string | null;
}

/**
 * Withdraw the units a refunded or disputed GAU block purchase granted.
 *
 * Returns null when the event is not against a GAU purchase, which is the
 * caller's signal to fall through to the usage-credit clawback.
 *
 * How much is withdrawn (ADR-085 §14): what the money is worth against the
 * settlement, capped at what that purchase has left to give — its
 * `quantity_gau` less the `requested_gau` already recorded by reversal rows
 * for it. A refund and a dispute of one purchase are distinct events with
 * distinct ids, so each arrives here on its own; without the cap the second
 * prices itself against the full quantity again and takes units that a
 * DIFFERENT purchase paid for, since a bucket is one balance for the
 * organisation rather than a balance per purchase.
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
    if (!args.paymentIntentId) return null;
    // Before anything is read or decided. A concurrent grant for this same
    // PaymentIntent waits here and then sees the row this transaction parks.
    await lockPurchaseByPaymentIntent(tx, args.paymentIntentId);

    // Idempotency: Stripe redelivers. Keyed on (PaymentIntent, provider event)
    // by `gau_reversals_payment_intent_event_idx` — the PaymentIntent rather
    // than the settlement, so the key still holds for a row parked before its
    // purchase was known. Checked before the settlement lookup for the same
    // reason.
    const existing = await tx.query.gauReversals.findFirst({
      where: and(
        eq(schema.gauReversals.stripePaymentIntentId, args.paymentIntentId),
        eq(schema.gauReversals.providerEventId, args.providerEventId),
      ),
    });
    if (existing) {
      // Stripe's `amount_refunded` is CUMULATIVE over the charge, so a second
      // partial refund redelivers the same charge id with a larger figure.
      // Keyed on the charge alone, that reads as a redelivery and withdraws
      // nothing: the customer gets more money back and keeps the units it
      // bought. Compare the amounts instead of the ids — an identical amount
      // IS a redelivery, a larger one is new money, and a smaller one is a
      // stale delivery arriving out of order and is ignored.
      if (args.amountCents <= existing.amountCents) {
        return {
          pending: existing.settlementId === null,
          orgId: existing.orgId,
          settlementId: existing.settlementId,
          bucketId: existing.bucketId,
          requestedGau: existing.requestedGau,
          reversedGau: existing.reversedGau,
          unrecoveredGau: existing.unrecoveredGau,
          applied: false,
        } satisfies GauReversalResult;
      }
      return applyCumulativeIncrease(tx, {
        existing,
        amountCents: args.amountCents,
        paymentIntentId: args.paymentIntentId,
        now,
      });
    }

    const settlement = await findPurchaseByPaymentIntent(
      tx,
      args.paymentIntentId,
    );

    if (!settlement) {
      // No purchase recorded for this PaymentIntent. If the event itself says
      // it was a block purchase, the grant simply has not run yet — Stripe does
      // not order deliveries, and a grant that failed once is retried later.
      //
      // Park the reversal instead of dropping it. Returning here without a row
      // would mark the webhook processed (processStripeEvent only re-dispatches
      // an event whose handler THREW), so the refund would never be seen again
      // while the retried grant went on to hand out the full purchase — the
      // money-loss this module exists to prevent, reached by the opposite
      // ordering. `grantGauPurchaseForCheckout` reconciles this row before it
      // makes any unit spendable.
      if (!args.gauPurchaseOrgId) return null;
      await tx.insert(schema.gauReversals).values({
        orgId: args.gauPurchaseOrgId,
        settlementId: null,
        bucketId: null,
        stripePaymentIntentId: args.paymentIntentId,
        kind: args.kind,
        providerEventId: args.providerEventId,
        // The units are not knowable yet: the quantity and the rate live on
        // the settlement. The money is, and it is what reconciliation prorates.
        requestedGau: 0,
        reversedGau: 0,
        unrecoveredGau: 0,
        amountCents: args.amountCents,
        currency: args.currency,
      });
      return {
        pending: true,
        orgId: args.gauPurchaseOrgId,
        settlementId: null,
        bucketId: null,
        requestedGau: 0,
        reversedGau: 0,
        unrecoveredGau: 0,
        applied: true,
      } satisfies GauReversalResult;
    }

    // Capped by what the purchase has left to give, not just by what the
    // money is worth. A refund and a dispute of the same purchase are distinct
    // events with distinct ids, so each reaches here on its own and would
    // otherwise price itself against the full quantity a second time.
    const requestedGau = remainingReversibleGau(
      settlement,
      args.amountCents,
      await requestedGauForSettlement(tx, settlement.id),
    );

    // One implementation for every single-debit path: resolves the CURRENT
    // bucket and takes its row lock, both of which the absolute write depends
    // on. See debitCurrentBucket.
    const { bucketId, reversedGau } = await debitCurrentBucket(tx, {
      orgId: settlement.orgId,
      units: requestedGau,
      now,
    });
    const unrecoveredGau = requestedGau - reversedGau;

    await tx.insert(schema.gauReversals).values({
      orgId: settlement.orgId,
      settlementId: settlement.id,
      bucketId,
      stripePaymentIntentId: args.paymentIntentId,
      kind: args.kind,
      providerEventId: args.providerEventId,
      requestedGau,
      reversedGau,
      unrecoveredGau,
      amountCents: args.amountCents,
      currency: args.currency,
    });

    return {
      pending: false,
      orgId: settlement.orgId,
      settlementId: settlement.id,
      bucketId,
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
  if (result.pending) {
    logger.warn(
      line,
      result.applied
        ? "billing: gau refund arrived before its purchase — reversal parked, the grant will reconcile it"
        : "billing: gau reversal already parked, skipping",
    );
  } else if (!result.applied) {
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
 * `amountRefundedCents` is CUMULATIVE over the charge, so a second partial
 * refund redelivers the same charge id carrying a larger figure. The
 * idempotency check therefore compares the amount and not just the id: an
 * equal amount is a redelivery and withdraws nothing, a larger one is new
 * money and withdraws the difference, and a smaller one is a stale delivery
 * arriving out of order and is ignored (ADR-085 §10).
 *
 * Treating a larger figure as a redelivery — which an id-only key does — is a
 * money-loss: the customer receives more money back and keeps the units.
 *
 * Whatever the sequence, no set of events against one purchase withdraws more
 * than the units it granted; the cap is computed across every reversal row for
 * the settlement before any debit (ADR-085 §14).
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
    // Only a charge carries what it bought, and only then can an unmatched
    // reversal be parked rather than handed to the usage-credit clawback.
    gauPurchaseOrgId:
      charge.metadata.oxagen_kind === "gau_purchase" ? charge.orgId : null,
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
 *
 * "The units" means the units this purchase has left, not its full quantity. A
 * dispute that follows a refund of the same purchase finds the entitlement
 * already spent and withdraws nothing, rather than taking another purchase's
 * units a second time (ADR-085 §14).
 */
export async function reverseGauPurchaseForDispute(
  dispute: BillingDispute,
  chargeMetadata?: Record<string, string>,
): Promise<GauReversalResult | null> {
  const metadata =
    chargeMetadata ?? (await readChargeMetadata(dispute.chargeId));
  return applyGauReversal({
    kind: "dispute",
    providerEventId: dispute.id,
    paymentIntentId: dispute.paymentIntentId,
    amountCents: dispute.amountCents,
    currency: dispute.currency,
    // A dispute carries neither the organisation nor what was bought — Stripe
    // does not copy charge metadata onto a Dispute — so both come from the
    // charge, and without them an unmatched dispute could not be parked and
    // was dropped exactly as an unmatched refund used to be (ADR-085 §7).
    gauPurchaseOrgId:
      metadata.oxagen_kind === "gau_purchase"
        ? orgIdOfChargeMetadata(metadata)
        : null,
  });
}

/**
 * A charge's metadata, or `{}` when there is no charge to read.
 *
 * One provider read per dispute. Disputes are rare and the alternative is
 * dropping them, so the call is worth its latency; it is made outside any
 * transaction because `onDisputeCreated` resolves before opening one.
 */
/**
 * The organisation a charge's metadata names, or null.
 *
 * Written as a function rather than inline because `Record<string, string>`
 * indexes to `string` without `noUncheckedIndexedAccess`, so `m.org_id ?? null`
 * reads to the compiler as dead code and to a human as a null check. The
 * annotated local is what makes the absent case real to both.
 */
export function orgIdOfChargeMetadata(
  metadata: Record<string, string>,
): string | null {
  const orgId: string | undefined = metadata.org_id;
  return orgId ?? null;
}

export async function readChargeMetadata(
  chargeId: string | null,
): Promise<Record<string, string>> {
  if (!chargeId) return {};
  return billingProvider().getChargeMetadata(chargeId);
}

/**
 * Settle every reversal parked against this purchase's PaymentIntent, at the
 * moment the purchase is recorded.
 *
 * Called by `grantGauPurchaseForCheckout` inside the same transaction as the
 * grant, so a purchase whose money already came back never has spendable units
 * between the two. The units are computed here and not at park time because
 * the quantity and the rate live on the settlement, which did not exist yet.
 *
 * Idempotent twice over: the grant reaches this only on the delivery that
 * actually inserted the settlement (`ON CONFLICT DO NOTHING` returns no row on
 * a redelivery, and the caller stops there), and the lookup itself matches only
 * rows still carrying `settlement_id IS NULL`, so a second pass finds nothing.
 *
 * Returns the reversals it settled, for the caller's log line.
 */
export async function reconcilePendingGauReversals(
  tx: Tx,
  args: {
    settlement: Pick<
      GauSettlementRow,
      "id" | "orgId" | "quantityGau" | "ratePerGauMicros" | "chargedCents"
    >;
    paymentIntentId: string | null;
    now: Date;
  },
): Promise<GauReversalResult[]> {
  if (!args.paymentIntentId) return [];
  // The other half of the pair. A concurrent refund for this PaymentIntent
  // waits here and then sees the settlement this transaction inserted, so it
  // takes the matched path instead of parking a row nobody will reconcile.
  await lockPurchaseByPaymentIntent(tx, args.paymentIntentId);
  const pending = await tx
    .select()
    .from(schema.gauReversals)
    .where(
      and(
        eq(schema.gauReversals.stripePaymentIntentId, args.paymentIntentId),
        isNull(schema.gauReversals.settlementId),
      ),
    );
  if (pending.length === 0) return [];

  // The bucket's counts move as each reversal takes from them, so they are
  // tracked here rather than re-read: the caller holds the row lock for the
  // whole transaction, and a re-read would return the same numbers anyway.
  const settled: GauReversalResult[] = [];

  for (const row of pending) {
    // Re-read each time, not carried: the row updated at the end of the
    // previous iteration is part of this sum. Two events that both parked
    // before the grant are priced here one after the other, and without the
    // cap each would claim the whole purchase.
    const requestedGau = remainingReversibleGau(
      args.settlement,
      row.amountCents,
      await requestedGauForSettlement(tx, args.settlement.id, row.id),
    );
    // Each debit re-resolves and re-locks, so the next one reads the balance
    // this one left. That is why there is no running count to carry: the
    // running count only existed to stand in for a re-read, and standing in
    // for a re-read with a held snapshot is the defect this module has now
    // produced twice.
    const { bucketId, reversedGau } = await debitCurrentBucket(tx, {
      orgId: args.settlement.orgId,
      units: requestedGau,
      now: args.now,
    });

    await tx
      .update(schema.gauReversals)
      .set({
        settlementId: args.settlement.id,
        bucketId,
        requestedGau,
        reversedGau,
        unrecoveredGau: requestedGau - reversedGau,
      })
      .where(eq(schema.gauReversals.id, row.id));

    settled.push({
      pending: false,
      orgId: args.settlement.orgId,
      settlementId: args.settlement.id,
      bucketId,
      requestedGau,
      reversedGau,
      unrecoveredGau: requestedGau - reversedGau,
      applied: true,
    });
  }

  return settled;
}
