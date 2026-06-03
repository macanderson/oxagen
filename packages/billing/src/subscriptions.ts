import { db, schema } from "@oxagen/database";
import { eq, and, sql } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";
import { getOrgSeatUsage, SeatLimitError } from "./seats";

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
  prorationBehavior: "always_invoice" | "none" = "always_invoice",
): Promise<void> {
  logger.info({ stripeSubId, newPriceId, prorationBehavior }, "billing: upgrading subscription price");
  await billingProvider().upgradeSubscription(stripeSubId, { newPriceId, prorationBehavior });
  await syncSubscriptionFromStripe(stripeSubId);
}

/**
 * Update the seat count on an active subscription.
 *
 * Guard: if `seats` is less than the number of currently used seats
 * (active users + pending invitations), throws `SeatLimitError` — you
 * cannot drop below provisioned headcount.
 *
 * On success, updates the Stripe subscription item quantity (with immediate
 * proration invoicing) and syncs `seatCount` back to our DB.
 */
export async function setSubscriptionSeats(orgId: string, seats: number): Promise<void> {
  if (seats < 1) throw new Error("seats must be >= 1");

  const d = db();
  const row = await d.query.subscriptions.findFirst({
    where: and(
      eq(schema.subscriptions.orgId, orgId),
      sql`${schema.subscriptions.status} IN ('active','trialing')`,
    ),
    columns: { stripeSubscriptionId: true, seatCount: true },
  });
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);

  // Guard: cannot drop below current usage.
  if (seats < row.seatCount) {
    const usage = await getOrgSeatUsage(orgId);
    if (seats < usage.used) {
      throw new SeatLimitError(seats, usage.used);
    }
  }

  logger.info({ orgId, seats, previous: row.seatCount }, "billing: updating subscription seat count");
  await billingProvider().setSubscriptionSeats(row.stripeSubscriptionId, { seats });
  await syncSubscriptionFromStripe(row.stripeSubscriptionId);
}

/**
 * Change an org's plan to any other plan (any tier → any tier).
 *
 * Upgrade path  (target tier higher): swap price immediately, prorate now.
 * Downgrade path (target tier lower): swap price, prorate at period end (no
 *   immediate invoice — customer keeps access until cycle renews).
 *
 * If the org has NO active subscription (free tier), returns a Checkout
 * session URL for the new plan; the caller must redirect the user.
 * If one IS active, swaps the price in-place and returns null.
 *
 * Current seat count is preserved through a plan swap.
 */
export async function changeOrgPlan(
  orgId: string,
  targetPlanSlug: string,
  interval: "month" | "year",
  opts?: { successUrl?: string; cancelUrl?: string },
): Promise<{ checkoutUrl: string } | null> {
  const d = db();

  // Resolve target plan
  const targetPlan = await d.query.plans.findFirst({
    where: eq(schema.plans.slug, targetPlanSlug),
    columns: { id: true, tier: true, stripePriceIdMonthly: true, stripePriceIdAnnual: true },
  });
  if (!targetPlan) throw new Error(`Plan '${targetPlanSlug}' not found`);

  const newPriceId =
    interval === "year" ? targetPlan.stripePriceIdAnnual : targetPlan.stripePriceIdMonthly;
  if (!newPriceId) throw new Error(`Plan '${targetPlanSlug}' has no ${interval} price`);

  // Check for active subscription (two queries to avoid `with` inference issues).
  const activeSubRow = await d.query.subscriptions.findFirst({
    where: and(
      eq(schema.subscriptions.orgId, orgId),
      sql`${schema.subscriptions.status} IN ('active','trialing')`,
    ),
    columns: {
      stripeSubscriptionId: true,
      seatCount: true,
      planId: true,
    },
  });

  if (!activeSubRow) {
    // No active subscription — start a Checkout session.
    const { createCheckoutSession } = await import("./checkout");
    const result = await createCheckoutSession({
      orgId,
      planSlug: targetPlanSlug,
      interval,
      successUrl: opts?.successUrl,
      cancelUrl: opts?.cancelUrl,
    });
    logger.info(
      { orgId, targetPlanSlug, interval },
      "billing: changeOrgPlan — no active subscription, created checkout session",
    );
    return { checkoutUrl: result.url };
  }

  // Resolve current plan tier for proration decision.
  const currentPlanRow = await d.query.plans.findFirst({
    where: eq(schema.plans.id, activeSubRow.planId),
    columns: { tier: true },
  });

  // Active subscription — swap the price in-place.
  // Determine proration behavior by comparing tier order.
  const TIER_ORDER: Record<string, number> = { free: 0, build: 1, scale: 2, enterprise: 3 };
  const currentTierOrder = TIER_ORDER[currentPlanRow?.tier ?? "free"] ?? 0;
  const targetTierOrder = TIER_ORDER[targetPlan.tier] ?? 0;
  const isUpgrade = targetTierOrder >= currentTierOrder;
  const prorationBehavior: "always_invoice" | "none" = isUpgrade ? "always_invoice" : "none";

  // Use activeSubRow from now on (renamed to avoid confusion).
  const activeSub = activeSubRow;

  logger.info(
    {
      orgId,
      targetPlanSlug,
      interval,
      currentTier: currentPlanRow?.tier,
      targetTier: targetPlan.tier,
      isUpgrade,
      prorationBehavior,
    },
    "billing: changeOrgPlan — swapping price on active subscription",
  );

  await upgradeSubscription(activeSub.stripeSubscriptionId, newPriceId, prorationBehavior);

  // Preserve seat count: if current seatCount > 1, update the quantity after
  // the price swap. upgradeSubscription keeps the same item, so quantity persists
  // through the price swap automatically — no extra call needed.

  return null;
}
