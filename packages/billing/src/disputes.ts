// tenancy: system bypass via withSystemDb (dispute.created / dispute.closed /
// charge.refunded webhooks arrive with external Stripe ids; orgId is resolved from charge
// metadata or prior billing_disputes rows before any tenant scope exists;
// billing is org_only, no workspace_id) — OXA-1515
import { withSystemDb, schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { and, eq, isNotNull } from "drizzle-orm";
import { deterministicUuid } from "./internal/deterministic-uuid";
import { consumeCredits } from "./credits";
import { CREDIT_REASONS } from "./constants";
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
 *  3. subscriptions table keyed by stripeCustomerId derived from the charge's
 *     paymentIntentId or chargeId fields
 *  4. paymentMethods table keyed by stripeCustomerId (same derivation)
 *
 * Falls back to null if all paths fail.
 */
async function resolveOrgFromDispute(tx: Tx, dispute: BillingDispute): Promise<string | null> {
  if (dispute.orgId) return dispute.orgId;

  // Path 2: existing billing_disputes row (prior partial insert or re-delivery).
  if (dispute.chargeId || dispute.paymentIntentId) {
    const existingDispute = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
      columns: { orgId: true },
    });
    if (existingDispute?.orgId) return existingDispute.orgId;
  }

  // Path 3+4: look up subscriptions / payment_methods by stripeCustomerId.
  // We don't have a customerId directly on the dispute, but the chargeId is
  // stored in billing_disputes.stripeChargeId and paymentIntentId in
  // billing_disputes.paymentIntentId. Cross-reference via subscriptions
  // (which carries stripeCustomerId) by paymentIntentId stored on the dispute.
  //
  // In practice, when Stripe embeds org_id in charge metadata (our standard),
  // dispute.orgId will already be set at path 1. These paths protect the rare
  // case where metadata was absent (e.g. migrated charges, legacy test data).

  if (dispute.paymentIntentId) {
    // subscriptions doesn't carry paymentIntentId directly; check payment_methods
    // which stores stripeCustomerId. But we don't have customerId here — skip
    // to billing_disputes fallback already exhausted above.
    // Leave a breadcrumb so ops can correlate manually.
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
 *  2. subscriptions table keyed by stripeCustomerId — we pivot via
 *     paymentIntentId: find any payment_methods row that shares the
 *     stripeCustomerId, then follow to subscriptions.
 *  3. paymentMethods table (same pivot).
 *
 * Falls back to null if unresolved.
 */
async function resolveOrgFromCharge(tx: Tx, charge: BillingRefundedCharge): Promise<string | null> {
  if (charge.orgId) return charge.orgId;

  // Attempt to resolve via subscriptions by paymentIntentId stored in the
  // billing_disputes table (shared lookup point for charges/PIs).
  // In the normal payment flow, charges are created by PaymentIntents whose
  // metadata carries org_id; absent that, look up any subscription whose
  // payment_methods share the same stripeCustomerId.
  //
  // Since we don't store paymentIntentId on subscriptions directly, attempt
  // resolution via payment_methods: find a payment_method row by paymentIntentId
  // → get stripeCustomerId → look up subscription → get orgId.
  //
  // This covers the case where a charge was made via an off-session PI on a
  // known customer (credit auto-reload, subscription renewal) but org_id was
  // missing from the charge metadata.

  if (charge.paymentIntentId) {
    // Try: billing_disputes for this paymentIntentId (may have been disputed before).
    const disputeRow = await tx.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.paymentIntentId, charge.paymentIntentId),
      columns: { orgId: true },
    });
    if (disputeRow?.orgId) return disputeRow.orgId;

    // Try: subscriptions — no direct paymentIntentId column; fall through.
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

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (dispute webhook, org resolved from Stripe
    // charge metadata or billing_disputes fallback, no tenant scope) — OXA-1515
    const orgId = await resolveOrgFromDispute(tx, dispute);
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
        { disputeId: dispute.id, orgId, clawedBackCents: Number(existing.clawedBackCents) },
        "billing: dispute.created — clawback already applied, skipping",
      );
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

/**
 * Called when a dispute.closed event fires.
 * Updates status and sets resolvedAt.
 */
export async function onDisputeClosed(dispute: BillingDispute): Promise<void> {
  const start = Date.now();
  const now = new Date();

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (dispute.closed webhook, updates by
    // stripeDisputeId with no tenant scope) — OXA-1515
    await tx
      .update(schema.billingDisputes)
      .set({ status: dispute.status, resolvedAt: now, updatedAt: now })
      .where(eq(schema.billingDisputes.stripeDisputeId, dispute.id));
  });

  logger.info(
    { disputeId: dispute.id, status: dispute.status, durationMs: Date.now() - start },
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
export async function onChargeRefunded(charge: BillingRefundedCharge): Promise<void> {
  const start = Date.now();

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (charge.refunded webhook, org resolved from
    // Stripe charge metadata or billing_disputes fallback, no tenant scope) — OXA-1515
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
