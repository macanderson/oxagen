import { db, schema } from "@oxagen/database";
import { eq, and, sql } from "drizzle-orm";
import { billingProvider } from "./client.js";
import { logger } from "./logger.js";

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
 * Pulls the canonical subscription record from the billing provider and
 * upserts into billing.subscriptions. Idempotent on stripe_subscription_id.
 * The webhook handler invokes this for every subscription.* event so our
 * table mirrors the provider within one round trip.
 */
export async function syncSubscriptionFromStripe(stripeSubId: string): Promise<void> {
  const start = Date.now();
  const sub = await billingProvider().getSubscription(stripeSubId);
  const d = db();

  const orgId = sub.metadata?.org_id ?? null;
  if (!orgId) {
    // No tenant metadata = subscription was created outside our flow.
    // Bail silently; later events may carry the tenant once attached.
    logger.warn({ stripeSubId }, "billing: subscription has no org_id metadata, skipping sync");
    return;
  }

  const planId = await resolvePlanId(sub.productId);
  if (!planId) {
    logger.warn({ stripeSubId, productId: sub.productId }, "billing: unknown product id, cannot sync subscription");
    return; // Unknown plan; cannot upsert without referential integrity.
  }

  const row = {
    orgId,
    planId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: sub.customerId,
    status: sub.status,
    billingInterval: sub.billingInterval,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt,
    trialEnd: sub.trialEnd,
    seatCount: sub.seatCount,
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

  logger.info(
    { orgId, stripeSubId, status: sub.status, durationMs: Date.now() - start },
    "billing: subscription synced",
  );
}

export async function cancelSubscription(stripeSubId: string, atPeriodEnd = true): Promise<void> {
  const provider = billingProvider();
  if (atPeriodEnd) {
    await provider.updateSubscription(stripeSubId, { cancelAtPeriodEnd: true });
  } else {
    await provider.cancelSubscription(stripeSubId);
  }
  await syncSubscriptionFromStripe(stripeSubId);
}

export async function reactivateSubscription(stripeSubId: string): Promise<void> {
  await billingProvider().updateSubscription(stripeSubId, { cancelAtPeriodEnd: false });
  await syncSubscriptionFromStripe(stripeSubId);
}

/**
 * Cancel the active subscription for an organisation at period end.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link cancelSubscription}. Raises if no active subscription is found.
 */
export async function cancelOrgSubscription(orgId: string): Promise<void> {
  const d = db();
  const row = await d.query.subscriptions.findFirst({
    where: and(
      eq(schema.subscriptions.orgId, orgId),
      sql`${schema.subscriptions.status} in ('active','trialing')`,
    ),
    columns: { stripeSubscriptionId: true },
  });
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);
  logger.info({ orgId, stripeSubId: row.stripeSubscriptionId }, "billing: cancelling org subscription at period end");
  await cancelSubscription(row.stripeSubscriptionId, true);
}

/**
 * Undo a scheduled cancellation for the active subscription of an organisation.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link reactivateSubscription}.
 */
export async function reactivateOrgSubscription(orgId: string): Promise<void> {
  const d = db();
  const row = await d.query.subscriptions.findFirst({
    where: and(
      eq(schema.subscriptions.orgId, orgId),
      sql`${schema.subscriptions.status} in ('active','trialing','past_due')`,
    ),
    columns: { stripeSubscriptionId: true },
  });
  if (!row) throw new Error(`No cancellable subscription found for org ${orgId}`);
  logger.info({ orgId, stripeSubId: row.stripeSubscriptionId }, "billing: reactivating org subscription");
  await reactivateSubscription(row.stripeSubscriptionId);
}

export async function upgradeSubscription(
  stripeSubId: string,
  newPriceId: string,
): Promise<void> {
  logger.info({ stripeSubId, newPriceId }, "billing: upgrading subscription price");
  await billingProvider().upgradeSubscription(stripeSubId, { newPriceId });
  await syncSubscriptionFromStripe(stripeSubId);
}
