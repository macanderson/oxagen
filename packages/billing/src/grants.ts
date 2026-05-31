import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { createCreditLot } from "./credits.js";
import { stripeClient } from "./client.js";
import { syncSubscriptionFromStripe } from "./subscriptions.js";

/**
 * The grant half of the credit loop: payments deposit credits into lots, the
 * gate ({@link import("./metering.js").chargeUsageCredits}) spends them.
 * All grants go through {@link createCreditLot} so every balance move creates
 * both a lot entry and a ledger row.
 *
 * Idempotency is enforced twice over: callers run inside
 * {@link import("./webhooks.js").processStripeEvent} (de-dups per
 * stripe_event_id), AND each grant is keyed by a stable `referenceId` and
 * skipped if the ledger already holds that grant. Belt-and-suspenders means a
 * Stripe retry deposits credits exactly once.
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
 * A stable UUID derived from an external (non-UUID) Stripe id, so it can live
 * in the `uuid`-typed credit_ledger.reference_id and key idempotency.
 */
function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Has this exact grant (reason + reference) already landed in the ledger? */
async function alreadyGranted(
  orgId: string,
  reason: string,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  const existing = await db().query.creditLedger.findFirst({
    where: and(
      eq(schema.creditLedger.orgId, orgId),
      eq(schema.creditLedger.reason, reason),
      eq(schema.creditLedger.referenceType, referenceType),
      eq(schema.creditLedger.referenceId, referenceId),
    ),
    columns: { id: true },
  });
  return Boolean(existing);
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
 * platform without a payment method. Idempotent: if the ledger already holds
 * a grant_signup entry for the org it is skipped.
 */
export async function grantFreeCredits(orgId: string): Promise<void> {
  // Idempotency: only grant once per org.
  if (await alreadyGranted(orgId, "grant_signup", "org", orgId)) return;

  await createCreditLot({
    orgId,
    amountCents: FREE_SIGNUP_CREDITS,
    source: "free_grant",
    expiresAt: null, // free grants never expire
    reason: "grant_signup",
    referenceType: "org",
    referenceId: orgId,
  });
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
export async function grantPlanCreditsForInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.billing_reason || !SUBSCRIPTION_GRANT_REASONS.has(invoice.billing_reason)) return;
  const subId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id ?? null;
  if (!subId) return;

  // Make sure our subscriptions row exists before resolving the plan.
  await syncSubscriptionFromStripe(subId);

  const d = db();
  const sub = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeSubscriptionId, subId),
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
    where: eq(schema.invoices.stripeInvoiceId, invoice.id),
    columns: { id: true },
  });
  const referenceId = invoiceRow?.id;
  if (
    referenceId &&
    (await alreadyGranted(sub.orgId, "grant_plan_renewal", "stripe_invoice", referenceId))
  ) {
    return;
  }

  // Subscription credits expire at the end of the grant month.
  const grantDate = new Date();
  const expiresAt = endOfGrantMonth(grantDate);

  await createCreditLot({
    orgId: sub.orgId,
    amountCents: BigInt(credits),
    source: "subscription",
    expiresAt,
    reason: "grant_plan_renewal",
    referenceType: "stripe_invoice",
    referenceId,
  });
}

// ---------------------------------------------------------------------------
// Credit pack purchase grant (checkout.session.completed)
// ---------------------------------------------------------------------------

/**
 * Grant a one-time credit pack's credits when its Checkout session completes.
 * Purchase packs expire 1 year from the grant date.
 */
export async function grantCreditPackForCheckout(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== "payment" || session.payment_status !== "paid") return;
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  const referenceId = deterministicUuid(`stripe_checkout_session:${session.id}`);
  if (await alreadyGranted(orgId, "grant_credit_pack", "stripe_checkout_session", referenceId)) {
    return;
  }

  const stripe = stripeClient();
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ["data.price.product"],
    limit: 100,
  });

  let totalCredits = 0;
  for (const item of lineItems.data) {
    const price = item.price;
    const product = price?.product;
    const creditsStr =
      price?.metadata?.credits ??
      (product && typeof product === "object" && "metadata" in product
        ? (product as Stripe.Product).metadata?.credits
        : undefined);
    const perUnit = creditsStr ? Number.parseInt(creditsStr, 10) : 0;
    if (Number.isFinite(perUnit) && perUnit > 0) {
      totalCredits += perUnit * (item.quantity ?? 1);
    }
  }
  if (totalCredits <= 0) return;

  // Purchase packs expire 1 year from today.
  const grantDate = new Date();
  const expiresAt = new Date(grantDate);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await createCreditLot({
    orgId,
    amountCents: BigInt(totalCredits),
    source: "purchase",
    expiresAt,
    reason: "grant_credit_pack",
    referenceType: "stripe_checkout_session",
    referenceId,
  });
}
