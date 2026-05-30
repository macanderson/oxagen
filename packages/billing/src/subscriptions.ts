import type Stripe from "stripe";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { stripeClient } from "./client.js";

const ALLOWED_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

function pickInterval(sub: Stripe.Subscription): "month" | "year" {
  const item = sub.items.data[0];
  const interval = item?.price?.recurring?.interval;
  return interval === "year" ? "year" : "month";
}

async function resolvePlanId(stripeProductId: string | null): Promise<string | null> {
  if (!stripeProductId) return null;
  const d = db();
  const plan = await d.query.plans.findFirst({
    where: eq(schema.plans.stripeProductId, stripeProductId),
    columns: { id: true },
  });
  return plan?.id ?? null;
}

/**
 * Pulls the canonical subscription record from Stripe and upserts into
 * billing.subscriptions. Idempotent on stripe_subscription_id. The webhook
 * handler invokes this for every subscription.* event so our table mirrors
 * Stripe within one round trip.
 */
export async function syncSubscriptionFromStripe(stripeSubId: string): Promise<void> {
  const sub = await stripeClient().subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price.product"],
  });
  const d = db();

  const orgId = (sub.metadata?.org_id as string | undefined) ?? null;
  if (!orgId) {
    // No tenant metadata = subscription was created outside our flow.
    // Bail silently; later events may carry the tenant once attached.
    return;
  }

  const productId =
    typeof sub.items.data[0]?.price?.product === "string"
      ? sub.items.data[0]?.price?.product
      : (sub.items.data[0]?.price?.product as Stripe.Product | undefined)?.id ?? null;
  const planId = await resolvePlanId(productId);
  if (!planId) return; // Unknown plan; cannot upsert without referential integrity.

  const status = ALLOWED_STATUSES.has(sub.status) ? sub.status : "incomplete";
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const row = {
    orgId,
    planId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: customerId,
    status,
    billingInterval: pickInterval(sub),
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    seatCount: sub.items.data[0]?.quantity ?? 1,
  };

  await d
    .insert(schema.subscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: schema.subscriptions.stripeSubscriptionId,
      set: {
        status: row.status,
        billingInterval: row.billingInterval,
        currentPeriodStart: row.currentPeriodStart,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        canceledAt: row.canceledAt,
        trialEnd: row.trialEnd,
        seatCount: row.seatCount,
        updatedAt: new Date(),
      },
    });
}

export async function cancelSubscription(stripeSubId: string, atPeriodEnd = true): Promise<void> {
  const stripe = stripeClient();
  if (atPeriodEnd) {
    await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });
  } else {
    await stripe.subscriptions.cancel(stripeSubId);
  }
  await syncSubscriptionFromStripe(stripeSubId);
}

export async function reactivateSubscription(stripeSubId: string): Promise<void> {
  await stripeClient().subscriptions.update(stripeSubId, { cancel_at_period_end: false });
  await syncSubscriptionFromStripe(stripeSubId);
}

export async function upgradeSubscription(
  stripeSubId: string,
  newPriceId: string,
): Promise<void> {
  const stripe = stripeClient();
  const sub = await stripe.subscriptions.retrieve(stripeSubId);
  const item = sub.items.data[0];
  if (!item) throw new Error("subscription has no items");
  await stripe.subscriptions.update(stripeSubId, {
    items: [{ id: item.id, price: newPriceId }],
    // Proration billed immediately so the customer sees the change reflected
    // in their next invoice — matches the invoicing expectation in §6.13.
    proration_behavior: "always_invoice",
  });
  await syncSubscriptionFromStripe(stripeSubId);
}
