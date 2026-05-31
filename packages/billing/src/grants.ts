import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { grantCredits } from "./credits.js";
import { stripeClient } from "./client.js";
import { syncSubscriptionFromStripe } from "./subscriptions.js";
import { CREDIT_REASONS } from "./constants.js";

/**
 * The grant half of the credit loop: payments deposit credits, the gate
 * ({@link import("./metering.js").chargeUsageCredits}) spends them. Both halves
 * funnel through {@link grantCredits} so every balance move is one ledger row.
 *
 * Idempotency is enforced twice over: callers run inside
 * {@link import("./webhooks.js").processStripeEvent} (de-dups per
 * stripe_event_id), AND each grant is keyed by a stable `referenceId` and
 * skipped if the ledger already holds that grant. Belt-and-suspenders means a
 * Stripe retry — even one that re-enters dispatch after a prior partial failure
 * — deposits credits exactly once.
 */

const SUBSCRIPTION_GRANT_REASONS: ReadonlySet<string> = new Set([
  "subscription_create",
  "subscription_cycle",
]);

/**
 * A stable UUID derived from an external (non-UUID) Stripe id, so it can live in
 * the `uuid`-typed credit_ledger.reference_id and key idempotency. Deterministic
 * → the same Stripe object always maps to the same reference id.
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
 * Grant a subscription's included credits when its invoice is paid. Fires on
 * the first invoice (`subscription_create`) and every renewal
 * (`subscription_cycle`); upgrades/one-offs are ignored so we never
 * double-grant within a period. Keyed by the internal invoice UUID — one grant
 * per invoice, forever.
 */
export async function grantPlanCreditsForInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.billing_reason || !SUBSCRIPTION_GRANT_REASONS.has(invoice.billing_reason)) return;
  const subId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id ?? null;
  if (!subId) return;

  // Make sure our subscriptions row exists before resolving the plan — the
  // sync is idempotent, so calling it here is safe even if subscription.created
  // already ran.
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

  // syncInvoiceFromStripe (run earlier in the webhook dispatch) mirrored the
  // invoice, so its internal UUID exists and keys the grant idempotently.
  const invoiceRow = await d.query.invoices.findFirst({
    where: eq(schema.invoices.stripeInvoiceId, invoice.id),
    columns: { id: true },
  });
  const referenceId = invoiceRow?.id;
  if (referenceId && (await alreadyGranted(sub.orgId, CREDIT_REASONS.GRANT_PLAN_RENEWAL, "stripe_invoice", referenceId))) {
    return;
  }

  await grantCredits({
    orgId: sub.orgId,
    deltaCents: BigInt(credits),
    reason: CREDIT_REASONS.GRANT_PLAN_RENEWAL,
    referenceType: "stripe_invoice",
    referenceId,
  });
}

/**
 * Grant a one-time credit pack's credits when its Checkout session completes.
 * Credit counts ride on the price metadata (`credits`) written by the sync
 * script, falling back to the product metadata. Keyed by a deterministic UUID
 * of the session id so a retry deposits exactly once.
 */
export async function grantCreditPackForCheckout(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== "payment" || session.payment_status !== "paid") return;
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  const referenceId = deterministicUuid(`stripe_checkout_session:${session.id}`);
  if (await alreadyGranted(orgId, CREDIT_REASONS.GRANT_CREDIT_PACK, "stripe_checkout_session", referenceId)) return;

  const stripe = stripeClient();
  const lineItems = await stripe.checkout.sessions
    .listLineItems(session.id, { expand: ["data.price.product"], limit: 100 })
    .autoPagingToArray({ limit: 10_000 });

  let totalCredits = 0;
  for (const item of lineItems) {
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

  await grantCredits({
    orgId,
    deltaCents: BigInt(totalCredits),
    reason: CREDIT_REASONS.GRANT_CREDIT_PACK,
    referenceType: "stripe_checkout_session",
    referenceId,
  });
}
