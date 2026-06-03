import { createHash } from "node:crypto";
import { db, schema } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { billingProvider } from "./client";
import { syncSubscriptionFromStripe } from "./subscriptions";
import { CREDIT_REASONS } from "./constants";
import { logger } from "./logger";
import type { BillingCheckoutSession, BillingInvoice } from "./provider";

/**
 * The grant half of the credit loop: payments deposit credits into lots, the
 * gate ({@link import("./metering").chargeUsageCredits}) spends them.
 * All grants go through a single transaction that:
 *  1. INSERT INTO credit_ledger … ON CONFLICT DO NOTHING  ← atomic idempotency
 *  2. INSERT INTO credit_lots
 *  3. Upsert credit_balances
 *
 * The ON CONFLICT DO NOTHING on step 1 requires a UNIQUE constraint on
 * credit_ledger(org_id, reason, reference_type, reference_id). This replaces
 * the prior TOCTOU check-then-insert (OXA-1509). See the agent summary for the
 * cross-agent schema dependency.
 *
 * EXPIRY RULES:
 *   free_grant   → expires_at NULL (never expires; used for signup grants too)
 *   subscription → expires_at = end of the grant month (use-it-or-lose-it)
 *   purchase     → expires_at = granted_at + 1 year
 */

const SUBSCRIPTION_GRANT_REASONS: ReadonlySet<string> = new Set([
  "subscription_create",
  "subscription_cycle",
]);

/**
 * A stable UUID derived from an external (non-UUID) provider id, so it can
 * live in the `uuid`-typed credit_ledger.reference_id and key idempotency.
 */
function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Drizzle transaction type alias (avoids importing internal types). */
type DbTx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * Attempt to insert the grant ledger row atomically.
 *
 * Returns true when the row was inserted (grant not yet applied) and false when
 * it conflicted (already granted). A conflict means another request already
 * landed the same (org_id, reason, reference_type, reference_id) combination.
 *
 * Atomicity depends on the partial UNIQUE index
 *   credit_ledger_grant_idempotency_idx
 *   ON credit_ledger(org_id, reason, reference_type, reference_id)
 *   WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
 * declared in the Drizzle schema (schema/billing.ts) and created by migration
 * 0014_billing_credit_ledger_idempotency. ON CONFLICT DO NOTHING uses it as
 * the arbiter; without it every insert would succeed and duplicate-grant.
 */
async function tryInsertGrantLedger(
  tx: DbTx,
  orgId: string,
  reason: string,
  referenceType: string,
  referenceId: string,
  amountCents: bigint,
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.creditLedger)
    .values({
      orgId,
      deltaCents: amountCents,
      reason,
      referenceType,
      referenceId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.creditLedger.id });

  return inserted.length > 0;
}

/**
 * Insert a credit lot and upsert the credit_balances mirror inside a running
 * transaction. Used by all grant paths after the ledger row is confirmed.
 */
async function insertLotAndMirrorBalance(
  tx: DbTx,
  orgId: string,
  source: "free_grant" | "subscription" | "purchase",
  amountCents: bigint,
  grantedAt: Date,
  expiresAt: Date | null,
): Promise<void> {
  await tx.insert(schema.creditLots).values({
    orgId,
    source,
    originalCents: amountCents,
    remainingCents: amountCents,
    grantedAt,
    expiresAt,
  });

  await tx
    .insert(schema.creditBalances)
    .values({ orgId, balanceCents: amountCents, lastEventAt: grantedAt })
    .onConflictDoUpdate({
      target: schema.creditBalances.orgId,
      set: {
        balanceCents: sql`${schema.creditBalances.balanceCents} + ${amountCents}`,
        lastEventAt: grantedAt,
        updatedAt: grantedAt,
      },
    });
}

/**
 * Returns the last moment of the month containing the given date (UTC).
 * Subscription credits expire at end-of-grant-month so unused allotments
 * don't roll over.
 */
function endOfGrantMonth(grantDate: Date): Date {
  // First day of the following month at midnight UTC, minus 1ms.
  const d = new Date(Date.UTC(grantDate.getUTCFullYear(), grantDate.getUTCMonth() + 1, 1));
  d.setUTCMilliseconds(-1);
  return d;
}

// ---------------------------------------------------------------------------
// Free signup grant — 500 credits, never expiring
// ---------------------------------------------------------------------------

const FREE_SIGNUP_CREDITS = 500n; // 500 credits = $5.00

/**
 * Grant 500 non-expiring free credits to a newly-created org.
 * Called immediately after org creation so the org can start using the
 * platform without a payment method.
 *
 * Idempotency is enforced atomically via INSERT … ON CONFLICT DO NOTHING
 * on the credit_ledger unique key (org_id, reason, reference_type,
 * reference_id). No separate SELECT is needed.
 */
export async function grantFreeCredits(orgId: string): Promise<void> {
  const start = Date.now();
  let granted = false;

  await db().transaction(async (tx) => {
    granted = await tryInsertGrantLedger(
      tx,
      orgId,
      CREDIT_REASONS.GRANT_SIGNUP,
      "org",
      orgId,
      FREE_SIGNUP_CREDITS,
    );
    if (!granted) return; // Already granted — conflict, nothing to do.
    await insertLotAndMirrorBalance(tx, orgId, "free_grant", FREE_SIGNUP_CREDITS, new Date(), null);
  });

  if (granted) {
    logger.info(
      { orgId, amountCents: Number(FREE_SIGNUP_CREDITS), durationMs: Date.now() - start },
      "billing: free signup credits granted",
    );
  } else {
    logger.debug({ orgId }, "billing: free signup credits already granted, skipping");
  }
}

// ---------------------------------------------------------------------------
// Subscription plan credit grant (invoice.paid)
// ---------------------------------------------------------------------------

/**
 * Grant a subscription's included credits when its invoice is paid. Fires on
 * the first invoice (`subscription_create`) and every renewal
 * (`subscription_cycle`); upgrades/one-offs are ignored so we never
 * double-grant within a period.
 *
 * Subscription credits expire at the end of the calendar month in which the
 * invoice was paid (use-it-or-lose-it).
 */
export async function grantPlanCreditsForInvoicePaid(invoice: BillingInvoice): Promise<void> {
  if (!invoice.billingReason || !SUBSCRIPTION_GRANT_REASONS.has(invoice.billingReason)) return;
  if (!invoice.subscriptionId) return;

  const start = Date.now();

  // Make sure our subscriptions row exists before resolving the plan.
  await syncSubscriptionFromStripe(invoice.subscriptionId);

  const d = db();
  const sub = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeSubscriptionId, invoice.subscriptionId),
    columns: { orgId: true, planId: true },
  });
  if (!sub) return;

  const plan = await d.query.plans.findFirst({
    where: eq(schema.plans.id, sub.planId),
    columns: { includedCreditCents: true },
  });
  const credits = plan?.includedCreditCents ?? 0;
  if (credits <= 0) return;

  const invoiceRow = await d.query.invoices.findFirst({
    where: eq(schema.invoices.stripeInvoiceId, invoice.providerInvoiceId),
    columns: { id: true },
  });
  const referenceId = invoiceRow?.id;
  if (!referenceId) return;

  const grantDate = new Date();
  const expiresAt = endOfGrantMonth(grantDate);
  const amountCents = BigInt(credits);

  let granted = false;
  await d.transaction(async (tx) => {
    granted = await tryInsertGrantLedger(
      tx,
      sub.orgId,
      CREDIT_REASONS.GRANT_PLAN_RENEWAL,
      "stripe_invoice",
      referenceId,
      amountCents,
    );
    if (!granted) return; // Already granted.
    await insertLotAndMirrorBalance(tx, sub.orgId, "subscription", amountCents, grantDate, expiresAt);
  });

  if (granted) {
    logger.info(
      {
        orgId: sub.orgId,
        amountCents: Number(amountCents),
        referenceId,
        expiresAt,
        durationMs: Date.now() - start,
      },
      "billing: plan renewal credits granted",
    );
  } else {
    logger.debug({ orgId: sub.orgId, referenceId }, "billing: plan renewal credits already granted, skipping");
  }
}

// ---------------------------------------------------------------------------
// Credit pack purchase grant (checkout.session.completed)
// ---------------------------------------------------------------------------

/**
 * Grant a one-time credit pack's credits when its Checkout session completes.
 * Purchase packs expire 1 year from the grant date.
 *
 * Idempotency is atomic: INSERT … ON CONFLICT DO NOTHING on the ledger row
 * keyed by (org_id, reason, "stripe_checkout_session", deterministicUuid(sessionId)).
 */
export async function grantCreditPackForCheckout(session: BillingCheckoutSession): Promise<void> {
  if (session.mode !== "payment" || session.paymentStatus !== "paid") return;
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  const start = Date.now();
  const referenceId = deterministicUuid(`stripe_checkout_session:${session.id}`);

  const lineItems = await billingProvider().getCheckoutSessionCreditPacks(session.id);
  let totalCredits = 0;
  for (const item of lineItems) {
    totalCredits += item.creditsPerUnit * item.quantity;
  }

  // Dynamic credit purchases do not have a pre-created Stripe Price, so there
  // are no credits encoded in price/product metadata. The checkout session
  // itself carries `credits` (= grantCents, the face value) in its metadata.
  // Fall back to that value when line items yield nothing.
  if (totalCredits <= 0) {
    const metaCredits = session.metadata?.credits;
    if (metaCredits) {
      const parsed = Number.parseInt(metaCredits, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        totalCredits = parsed;
      }
    }
  }

  if (totalCredits <= 0) return;

  const grantDate = new Date();
  const expiresAt = new Date(grantDate);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const amountCents = BigInt(totalCredits);

  let granted = false;
  await db().transaction(async (tx) => {
    granted = await tryInsertGrantLedger(
      tx,
      orgId,
      CREDIT_REASONS.GRANT_CREDIT_PACK,
      "stripe_checkout_session",
      referenceId,
      amountCents,
    );
    if (!granted) return;
    await insertLotAndMirrorBalance(tx, orgId, "purchase", amountCents, grantDate, expiresAt);
  });

  if (granted) {
    logger.info(
      {
        orgId,
        amountCents: Number(amountCents),
        sessionId: session.id,
        expiresAt,
        durationMs: Date.now() - start,
      },
      "billing: credit pack credits granted",
    );
  } else {
    logger.debug({ orgId, referenceId }, "billing: credit pack already granted, skipping");
  }
}
