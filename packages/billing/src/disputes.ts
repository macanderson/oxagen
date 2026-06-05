import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { consumeCredits } from "./credits";
import { CREDIT_REASONS } from "./constants";
import { logger } from "./logger";
import type { BillingDispute, BillingRefundInput } from "./provider";

// ---------------------------------------------------------------------------
// Org resolution helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an orgId from a dispute.
 * Priority: dispute.orgId → chargeId/customerId → paymentIntentId.
 * Falls back to null if resolution fails.
 */
async function resolveOrgFromDispute(dispute: BillingDispute): Promise<string | null> {
  if (dispute.orgId) return dispute.orgId;

  const d = db();

  // Best-effort: try resolving via the billing_disputes table if the dispute
  // was already partially inserted (shouldn't happen for created events, but
  // guards the closed path if the org was resolved earlier).
  if (dispute.chargeId || dispute.paymentIntentId) {
    const existingDispute = await d.query.billingDisputes.findFirst({
      where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
      columns: { orgId: true },
    });
    if (existingDispute?.orgId) return existingDispute.orgId;
  }

  logger.warn(
    { disputeId: dispute.id, chargeId: dispute.chargeId, paymentIntentId: dispute.paymentIntentId },
    "billing: dispute — could not resolve orgId",
  );
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
 */
export async function onDisputeCreated(dispute: BillingDispute): Promise<void> {
  const start = Date.now();

  const orgId = await resolveOrgFromDispute(dispute);
  if (!orgId) {
    logger.error(
      { disputeId: dispute.id },
      "billing: dispute.created — cannot process without orgId; dispute row NOT inserted",
    );
    return;
  }

  const d = db();
  const now = new Date();

  // Upsert the dispute row — idempotent on stripeDisputeId.
  const existing = await d.query.billingDisputes.findFirst({
    where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
    columns: { id: true, clawedBackCents: true },
  });

  if (!existing) {
    await d.insert(schema.billingDisputes).values({
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
    const { chargedCents } = await consumeCredits({
      orgId,
      requestedCents,
      reason: CREDIT_REASONS.CLAWBACK_DISPUTE,
      referenceType: "dispute",
      referenceId: dispute.id,
    });
    clawedBackCents = chargedCents;
  }

  // Record how much we clawed back.
  const disputeRow = await d.query.billingDisputes.findFirst({
    where: eq(schema.billingDisputes.stripeDisputeId, dispute.id),
    columns: { id: true },
  });

  if (disputeRow) {
    await d
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
}

/**
 * Called when a dispute.closed event fires.
 * Updates status and sets resolvedAt.
 */
export async function onDisputeClosed(dispute: BillingDispute): Promise<void> {
  const start = Date.now();
  const d = db();
  const now = new Date();

  await d
    .update(schema.billingDisputes)
    .set({ status: dispute.status, resolvedAt: now, updatedAt: now })
    .where(eq(schema.billingDisputes.stripeDisputeId, dispute.id));

  logger.info(
    { disputeId: dispute.id, status: dispute.status, durationMs: Date.now() - start },
    "billing: dispute closed",
  );
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

export interface RefundInput {
  paymentIntentId?: string;
  chargeId?: string;
  amountCents?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
  status: string;
}

/**
 * Issue a refund against a charge or PaymentIntent for an org.
 * Delegates directly to the billing provider.
 */
export async function refundOrgPayment(
  orgId: string,
  input: RefundInput,
): Promise<RefundResult> {
  const start = Date.now();

  const refundInput: BillingRefundInput = {
    paymentIntentId: input.paymentIntentId,
    chargeId: input.chargeId,
    amountCents: input.amountCents,
    reason: input.reason,
  };

  const result = await billingProvider().createRefund(refundInput);

  logger.info(
    {
      orgId,
      refundId: result.refundId,
      amountCents: result.amountCents,
      status: result.status,
      paymentIntentId: input.paymentIntentId ?? null,
      chargeId: input.chargeId ?? null,
      durationMs: Date.now() - start,
    },
    "billing: refund issued",
  );

  return {
    refundId: result.refundId,
    amountCents: result.amountCents,
    status: result.status,
  };
}
