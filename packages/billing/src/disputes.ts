// tenancy: system bypass via withSystemDb (dispute.created / dispute.closed /
// charge.refunded webhooks arrive with external Stripe ids; orgId is resolved from charge
// metadata or prior billing_disputes rows before any tenant scope exists;
// billing is org_only, no workspace_id).
import { withSystemDb, schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { and, eq, isNotNull } from "drizzle-orm";
import { deterministicUuid } from "./internal/deterministic-uuid";
import { consumeCredits } from "./credits";
import { CREDIT_REASONS } from "./constants";
import {
  reverseGauPurchaseForDispute,
  reverseGauPurchaseForRefund,
  type GauReversalResult,
} from "./gau-reversals";
import { logger } from "./logger";
import type { BillingDispute, BillingRefundedCharge } from "./provider";

// ---------------------------------------------------------------------------
// Org resolution helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an orgId from a dispute.
 *
 * Priority order:
 *  1. dispute.orgId (from Stripe charge metadata)
 *  2. Existing billing_disputes row (idempotent re-delivery can carry orgId)
 *
 * Falls back to null if both paths fail, and logs a warning so ops can
 * correlate the dispute manually.
 */
async function resolveOrgFromDispute(
  tx: Tx,
  dispute: BillingDispute,
): Promise<string | null> {
  if (dispute.orgId) return dispute.orgId;

  // Path 2: existing billing_disputes row (prior partial insert or re-delivery).
  if (dispute.chargeId || dispute.paymentIntentId) {
    const existingDispute = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
      columns: { orgId: true },
    });
    if (existingDispute?.orgId) return existingDispute.orgId;
  }

  // Path 1 reads the DISPUTE's own metadata, which Stripe does not copy from
  // the charge and nothing in this codebase sets, so it resolves only a
  // dispute an operator has annotated by hand. A GAU block purchase is
  // resolved before this function runs, off the settlement its PaymentIntent
  // names (ADR-085); a usage-credit dispute has no such record and reaches
  // here. Both paths above are exhausted, so leave a breadcrumb for ops to
  // correlate manually.

  if (dispute.paymentIntentId) {
    logger.warn(
      {
        disputeId: dispute.id,
        chargeId: dispute.chargeId,
        paymentIntentId: dispute.paymentIntentId,
      },
      "billing: dispute — orgId not in metadata and no prior dispute row; cannot auto-resolve",
    );
  } else {
    logger.warn(
      { disputeId: dispute.id },
      "billing: dispute — no orgId, no chargeId/paymentIntentId; cannot resolve org",
    );
  }

  return null;
}

/**
 * Attempt to resolve an orgId from a refunded charge.
 *
 * Priority order:
 *  1. charge.orgId (from Stripe charge metadata)
 *  2. billing_disputes row keyed by paymentIntentId (the charge was disputed before)
 *  3. billing_disputes row keyed by chargeId
 *
 * Falls back to null if unresolved.
 */
async function resolveOrgFromCharge(
  tx: Tx,
  charge: BillingRefundedCharge,
): Promise<string | null> {
  if (charge.orgId) return charge.orgId;

  if (charge.paymentIntentId) {
    // Try: billing_disputes for this paymentIntentId (may have been disputed before).
    const disputeRow = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.paymentIntentId, charge.paymentIntentId),
      columns: { orgId: true },
    });
    if (disputeRow?.orgId) return disputeRow.orgId;
  }

  // Try: billing_disputes for this chargeId.
  const disputeByCharge = await tx.query.billingDisputes.findFirst({
    where: eq(schema.billingDisputes.stripeChargeId, charge.id),
    columns: { orgId: true },
  });
  if (disputeByCharge?.orgId) return disputeByCharge.orgId;

  return null;
}

// ---------------------------------------------------------------------------
// Dispute handlers
// ---------------------------------------------------------------------------

/**
 * Called when a dispute.created event fires.
 *
 * 1. Resolves orgId.
 * 2. Upserts a billing_disputes row (idempotent on stripeDisputeId).
 * 3. Claws back credits up to amountCents via consumeCredits.
 * 4. Records clawedBackCents.
 *
 * If orgId cannot be resolved after all fallback paths, logs at CRITICAL level
 * with an alert tag so ops can act — does NOT silently swallow.
 */
export async function onDisputeCreated(dispute: BillingDispute): Promise<void> {
  const start = Date.now();

  // A disputed GAU block purchase gave the org units, not usage credits, so
  // its clawback is a withdrawal from the org's GAU bucket (ADR-085). Run
  // before the transaction below: the reversal opens its own, and the org it
  // resolves off the settlement is the only org a dispute can be attributed
  // to — a Stripe Dispute carries its own metadata, not the charge's, so
  // resolveOrgFromDispute cannot find one. Null means this dispute is not
  // against a GAU purchase and the usage-credit clawback is the right one.
  const gauReversal = await reverseGauPurchaseForDispute(dispute);

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (dispute webhook, org resolved from Stripe
    // charge metadata or billing_disputes fallback, no tenant scope).
    const orgId =
      gauReversal?.orgId ?? (await resolveOrgFromDispute(tx, dispute));
    if (!orgId) {
      logger.fatal(
        {
          alert: "dispute_org_unresolved",
          stripeDisputeId: dispute.id,
          chargeId: dispute.chargeId,
          paymentIntentId: dispute.paymentIntentId,
          amountCents: dispute.amountCents,
        },
        "billing: dispute.created — CRITICAL: cannot resolve orgId; clawback NOT applied — manual intervention required",
      );
      return;
    }

    const now = new Date();

    // credit_ledger.reference_id is a UUID column, so the Stripe dispute id
    // (e.g. "dp_...") cannot be stored raw — derive a deterministic UUID from
    // it (same pattern as onChargeRefunded). This also makes the ledger
    // idempotency pre-check below stable across re-deliveries.
    const clawbackReferenceId = deterministicUuid(dispute.id);

    // Upsert the dispute row — idempotent on stripeDisputeId.
    const existing = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
      columns: { id: true, clawedBackCents: true },
    });

    if (!existing) {
      await tx.insert(schema.billingDisputes).values({
        orgId,
        stripeDisputeId: dispute.id,
        stripeChargeId: dispute.chargeId ?? null,
        paymentIntentId: dispute.paymentIntentId ?? null,
        amountCents: dispute.amountCents,
        currency: dispute.currency,
        reason: dispute.reason ?? null,
        status: dispute.status,
        clawedBackCents: 0n,
      });
    } else if (existing.clawedBackCents > 0n) {
      // Clawback already applied — idempotent return.
      logger.debug(
        {
          disputeId: dispute.id,
          orgId,
          clawedBackCents: Number(existing.clawedBackCents),
        },
        "billing: dispute.created — clawback already applied, skipping",
      );
      return;
    }

    if (gauReversal) {
      // The units are already withdrawn. `clawed_back_cents` stays 0 because
      // no credits were taken: debiting the usage-credit ledger for a purchase
      // that never credited it would take money from an unrelated balance.
      await tx
        .update(schema.billingDisputes)
        .set({ status: dispute.status, updatedAt: now })
        .where(eq(schema.billingDisputes.stripeDisputeId, dispute.id));
      logGauDispute(start, dispute, gauReversal);
      return;
    }

    // Claw back up to amountCents from the org's credit balance.
    const requestedCents = BigInt(dispute.amountCents);
    let clawedBackCents = 0n;

    if (requestedCents > 0n) {
      // Atomicity guard: consumeCredits opens its OWN withTenantDb transaction,
      // separate from this withSystemDb tx. If the outer tx (the
      // billing_disputes INSERT/UPDATE that carries clawedBackCents) rolls back
      // after consumeCredits has already committed its debit, a retried webhook
      // would see clawedBackCents == 0 and clawback a SECOND time — double
      // charging the org. The CLAWBACK_DISPUTE reason is NOT covered by the
      // grant_* partial unique index, so the ledger cannot self-dedupe. Mirror
      // onChargeRefunded: pre-check the ledger for an existing debit keyed to
      // this dispute and skip if one is present.
      const existingLedgerRow = await tx.query.creditLedger.findFirst({
        where: and(
          eq(schema.creditLedger.orgId, orgId),
          eq(schema.creditLedger.reason, CREDIT_REASONS.CLAWBACK_DISPUTE),
          eq(schema.creditLedger.referenceType, "dispute"),
          eq(schema.creditLedger.referenceId, clawbackReferenceId),
          isNotNull(schema.creditLedger.referenceId),
        ),
        columns: { id: true },
      });

      if (existingLedgerRow) {
        logger.debug(
          { disputeId: dispute.id, orgId, clawbackReferenceId },
          "billing: dispute.created — clawback ledger row already exists, skipping (idempotent)",
        );
        return;
      }

      const { chargedCents } = await consumeCredits({
        orgId,
        requestedCents,
        reason: CREDIT_REASONS.CLAWBACK_DISPUTE,
        referenceType: "dispute",
        referenceId: clawbackReferenceId,
      });
      clawedBackCents = chargedCents;
    }

    // Record how much we clawed back.
    const disputeRow = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
      columns: { id: true },
    });

    if (disputeRow) {
      await tx
        .update(schema.billingDisputes)
        .set({ clawedBackCents, status: dispute.status, updatedAt: now })
        .where(eq(schema.billingDisputes.id, disputeRow.id));
    }

    logger.warn(
      {
        orgId,
        disputeId: dispute.id,
        amountCents: dispute.amountCents,
        clawedBackCents: Number(clawedBackCents),
        reason: dispute.reason,
        status: dispute.status,
        durationMs: Date.now() - start,
      },
      "billing: dispute created — credits clawed back",
    );
  });
}

function logGauDispute(
  start: number,
  dispute: BillingDispute,
  reversal: GauReversalResult,
): void {
  logger.warn(
    {
      orgId: reversal.orgId,
      disputeId: dispute.id,
      amountCents: dispute.amountCents,
      settlementId: reversal.settlementId,
      reversedGau: reversal.reversedGau,
      unrecoveredGau: reversal.unrecoveredGau,
      reason: dispute.reason,
      status: dispute.status,
      durationMs: Date.now() - start,
    },
    "billing: dispute created against a gau purchase — units withdrawn, credits untouched",
  );
}

/**
 * Called when a dispute.closed event fires.
 * Updates status and sets resolvedAt.
 */
export async function onDisputeClosed(dispute: BillingDispute): Promise<void> {
  const start = Date.now();
  const now = new Date();

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (dispute.closed webhook, updates by
    // stripeDisputeId with no tenant scope).
    await tx
      .update(schema.billingDisputes)
      .set({ status: dispute.status, resolvedAt: now, updatedAt: now })
      .where(eq(schema.billingDisputes.stripeDisputeId, dispute.id));
  });

  logger.info(
    {
      disputeId: dispute.id,
      status: dispute.status,
      durationMs: Date.now() - start,
    },
    "billing: dispute closed",
  );
}

// ---------------------------------------------------------------------------
// Charge refund handler (charge.refunded webhook)
// ---------------------------------------------------------------------------

/**
 * Called when a `charge.refunded` event fires.
 *
 * Ops issues a refund in the Stripe dashboard → Stripe fires charge.refunded →
 * we clawback `amountRefundedCents` worth of credits from the org.
 *
 * Idempotency: before calling consumeCredits, we check for an existing
 * credit_ledger row with (orgId, reason=REFUND, referenceType='charge_refund',
 * referenceId=deterministicUuid(charge.id)). This matches the partial unique
 * index `credit_ledger_grant_idempotency_idx` used by the grants layer, so a
 * repeat webhook cannot double-clawback.
 *
 * If orgId cannot be resolved after all fallback paths, logs at CRITICAL level
 * with an alert tag — does NOT silently swallow.
 */
export async function onChargeRefunded(
  charge: BillingRefundedCharge,
): Promise<void> {
  const start = Date.now();

  // A refunded GAU block purchase gave the org units, not usage credits
  // (ADR-085). Run before the transaction below: the reversal opens its own.
  const gauReversal = await reverseGauPurchaseForRefund(charge);
  if (gauReversal) {
    logger.warn(
      {
        orgId: gauReversal.orgId,
        chargeId: charge.id,
        paymentIntentId: charge.paymentIntentId,
        amountRefundedCents: charge.amountRefundedCents,
        settlementId: gauReversal.settlementId,
        reversedGau: gauReversal.reversedGau,
        unrecoveredGau: gauReversal.unrecoveredGau,
        pending: gauReversal.pending,
        durationMs: Date.now() - start,
      },
      gauReversal.pending
        ? "billing: charge.refunded arrived before its gau purchase — reversal parked for the grant to settle, credits untouched"
        : "billing: charge.refunded against a gau purchase — units withdrawn, credits untouched",
    );
    return;
  }

  if (charge.metadata.oxagen_kind === "gau_purchase") {
    // The charge says it bought units and no settlement claims its
    // PaymentIntent — and it could not be parked either, which leaves only one
    // case: the charge carries no `org_id`, so there is nothing to attribute a
    // pending reversal to. Retrying will not conjure the metadata, so this is
    // genuinely manual. The usage-credit clawback below would debit a balance
    // this charge never credited, so stop rather than take the wrong money.
    logger.fatal(
      {
        alert: "gau_reversal_unmatched",
        stripeChargeId: charge.id,
        paymentIntentId: charge.paymentIntentId,
        amountRefundedCents: charge.amountRefundedCents,
        orgId: charge.orgId,
      },
      "billing: charge.refunded — CRITICAL: refunded gau purchase carries no org and matches no settlement; units NOT withdrawn — manual intervention required",
    );
    return;
  }

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (charge.refunded webhook, org resolved from
    // Stripe charge metadata or billing_disputes fallback, no tenant scope).
    const orgId = await resolveOrgFromCharge(tx, charge);
    if (!orgId) {
      logger.fatal(
        {
          alert: "dispute_org_unresolved",
          stripeChargeId: charge.id,
          paymentIntentId: charge.paymentIntentId,
          amountRefundedCents: charge.amountRefundedCents,
        },
        "billing: charge.refunded — CRITICAL: cannot resolve orgId; clawback NOT applied — manual intervention required",
      );
      return;
    }

    if (charge.amountRefundedCents <= 0) {
      logger.debug(
        { chargeId: charge.id, orgId },
        "billing: charge.refunded — amountRefundedCents is 0, nothing to clawback",
      );
      return;
    }

    // Idempotency guard: check for an existing ledger row keyed to this charge.
    // Uses the same (orgId, reason, referenceType, referenceId) tuple that backs
    // the partial unique index, matching the pattern from onDisputeCreated.
    const refundReferenceId = deterministicUuid(charge.id);

    const existingLedgerRow = await tx.query.creditLedger.findFirst({
      where: and(
        eq(schema.creditLedger.orgId, orgId),
        eq(schema.creditLedger.reason, CREDIT_REASONS.REFUND),
        eq(schema.creditLedger.referenceType, "charge_refund"),
        eq(schema.creditLedger.referenceId, refundReferenceId),
        isNotNull(schema.creditLedger.referenceId),
      ),
      columns: { id: true },
    });

    if (existingLedgerRow) {
      logger.debug(
        { chargeId: charge.id, orgId, refundReferenceId },
        "billing: charge.refunded — clawback already applied, skipping (idempotent)",
      );
      return;
    }

    const requestedCents = BigInt(charge.amountRefundedCents);
    const { chargedCents } = await consumeCredits({
      orgId,
      requestedCents,
      reason: CREDIT_REASONS.REFUND,
      referenceType: "charge_refund",
      referenceId: refundReferenceId,
    });

    logger.info(
      {
        orgId,
        chargeId: charge.id,
        paymentIntentId: charge.paymentIntentId,
        amountRefundedCents: charge.amountRefundedCents,
        clawedBackCents: Number(chargedCents),
        durationMs: Date.now() - start,
      },
      "billing: charge.refunded — credits clawed back",
    );
  });
}
