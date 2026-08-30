import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { eq, and, sql } from "drizzle-orm";
import type { PlanTier } from "@oxagen/oxagen/types";
import { billingProvider } from "./client";
import { logger } from "./logger";
import { getOrgSeatUsage, SeatLimitError } from "./seats";
import { meetsMinimumTier } from "./entitlements";

const VALID_PLAN_TIERS: ReadonlySet<string> = new Set([
  "free",
  "build",
  "scale",
  "enterprise",
]);

function isPlanTier(value: string): value is PlanTier {
  return VALID_PLAN_TIERS.has(value);
}

// Type assertion helper - validates database strings are valid PlanTiers before comparison
function checkPlanTier(actual: string, minimum: string): boolean {
  const actualTier = isPlanTier(actual) ? actual : "free";
  const minimumTier = isPlanTier(minimum) ? minimum : "free";
  return meetsMinimumTier(actualTier, minimumTier);
}

/**
 * Pulls the canonical subscription record from the billing provider and
 * upserts into billing.subscriptions. Idempotent on stripe_subscription_id.
 * The webhook handler invokes this for every subscription.* event so our
 * table mirrors the provider within one round trip.
 *
 * tenancy: system bypass via withSystemDb (called from webhook dispatch, no tenant
 * scope; org resolved from Stripe subscription metadata).
 */
export async function syncSubscriptionFromStripe(
  stripeSubId: string,
): Promise<void> {
  const start = Date.now();
  const sub = await billingProvider().getSubscription(stripeSubId);

  const orgId = sub.metadata?.org_id ?? null;
  if (!orgId) {
    // No tenant metadata = subscription was created outside our flow.
    // Bail silently; later events may carry the tenant once attached.
    logger.warn(
      { stripeSubId },
      "billing: subscription has no org_id metadata, skipping sync",
    );
    return;
  }

  // Track whether this sync represents a Stripe-initiated cancellation so we can
  // emit an audit row outside the write transaction. The billing UI emits
  // billing.subscription_canceled when a USER cancels; a subscription can also
  // be canceled by Stripe itself (dunning exhaustion, non-payment, or an action
  // in the Stripe dashboard) with no UI path — those would otherwise leave no
  // SOC2 audit trail. We detect the transition INTO "canceled" here.
  let canceledTransition = false;

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (webhook path, resolves plan from Stripe
    // product id before a tenant scope exists; billing tables are org_only).
    const plan = await tx.query.plans.findFirst({
      where: eq(schema.plans.stripeProductId, sub.productId ?? ""),
      columns: { id: true },
    });
    const planId = plan?.id ?? null;

    if (!planId) {
      logger.warn(
        { stripeSubId, productId: sub.productId },
        "billing: unknown product id, cannot sync subscription",
      );
      return; // Unknown plan; cannot upsert without referential integrity.
    }

    // Read the prior status before the upsert so we only emit on the edge
    // (status entering "canceled"), never on repeated syncs of an already-
    // canceled subscription.
    const existing = await tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.stripeSubscriptionId, sub.id),
      columns: { status: true },
    });
    canceledTransition =
      sub.status === "canceled" && existing?.status !== "canceled";

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

    await tx
      .insert(schema.subscriptions)
      .values(row)
      .onConflictDoUpdate({
        target: schema.subscriptions.stripeSubscriptionId,
        set: {
          planId: row.planId,
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
      {
        orgId,
        stripeSubId,
        status: sub.status,
        durationMs: Date.now() - start,
      },
      "billing: subscription synced",
    );
  });

  // Provider-confirmed cancellation audit (system actor; no user session at the
  // webhook boundary). Fire-and-forget — never blocks the sync.
  if (canceledTransition) {
    emitSecurityEvent({
      eventType: "billing.subscription_canceled",
      actorUserId: null,
      orgId,
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    logger.info(
      { orgId, stripeSubId },
      "billing: subscription canceled (provider-confirmed) — audit emitted",
    );
  }
}

export async function cancelSubscription(
  stripeSubId: string,
  atPeriodEnd = true,
): Promise<void> {
  const provider = billingProvider();
  if (atPeriodEnd) {
    await provider.updateSubscription(stripeSubId, { cancelAtPeriodEnd: true });
  } else {
    await provider.cancelSubscription(stripeSubId);
  }
  await syncSubscriptionFromStripe(stripeSubId);
}

export async function reactivateSubscription(
  stripeSubId: string,
): Promise<void> {
  await billingProvider().updateSubscription(stripeSubId, {
    cancelAtPeriodEnd: false,
  });
  await syncSubscriptionFromStripe(stripeSubId);
}

/**
 * Cancel the active subscription for an organisation at period end.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link cancelSubscription}. Raises if no active subscription is found.
 */
export async function cancelOrgSubscription(orgId: string): Promise<void> {
  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} in ('active','trialing')`,
      ),
      columns: { stripeSubscriptionId: true },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);
  logger.info(
    { orgId, stripeSubId: row.stripeSubscriptionId },
    "billing: cancelling org subscription at period end",
  );
  await cancelSubscription(row.stripeSubscriptionId, true);
}

/**
 * Undo a scheduled cancellation for the active subscription of an organisation.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link reactivateSubscription}.
 */
export async function reactivateOrgSubscription(orgId: string): Promise<void> {
  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} in ('active','trialing','past_due')`,
      ),
      columns: { stripeSubscriptionId: true },
    }),
  );
  if (!row)
    throw new Error(`No cancellable subscription found for org ${orgId}`);
  logger.info(
    { orgId, stripeSubId: row.stripeSubscriptionId },
    "billing: reactivating org subscription",
  );
  await reactivateSubscription(row.stripeSubscriptionId);

  // SOC2 audit: a user undid a scheduled cancellation — a privileged billing
  // state change. Fire-and-forget — never blocks the reactivation.
  emitSecurityEvent({
    eventType: "billing.subscription_reactivated",
    actorUserId: null,
    orgId,
    workspaceId: null,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
}

export async function upgradeSubscription(
  stripeSubId: string,
  newPriceId: string,
  prorationBehavior: "always_invoice" | "none" = "always_invoice",
): Promise<void> {
  logger.info(
    { stripeSubId, newPriceId, prorationBehavior },
    "billing: upgrading subscription price",
  );
  // Idempotency: dedupe a double-submitted plan change (double-click / client
  // retry) so we never fire two proration invoices. Bucketed to a 10s window —
  // dedupes rapid resubmits, still allows a deliberate later change (Stripe
  // keys expire after 24h regardless).
  const idempotencyKey = `plan_change:${stripeSubId}:${newPriceId}:${Math.floor(Date.now() / 10_000)}`;
  await billingProvider().upgradeSubscription(stripeSubId, {
    newPriceId,
    prorationBehavior,
    idempotencyKey,
  });
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
export async function setSubscriptionSeats(
  orgId: string,
  seats: number,
): Promise<void> {
  if (seats < 1) throw new Error("seats must be >= 1");

  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} IN ('active','trialing')`,
      ),
      columns: { stripeSubscriptionId: true, seatCount: true },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);

  // Guard: cannot drop below current usage.
  if (seats < row.seatCount) {
    const usage = await getOrgSeatUsage(orgId);
    if (seats < usage.used) {
      throw new SeatLimitError(seats, usage.used);
    }
  }

  // Direction-aware proration: increases invoice immediately, decreases credit
  // on the next cycle (avoids surprising the customer with an immediate refund).
  const isIncrease = seats > row.seatCount;
  const prorationBehavior = isIncrease ? "always_invoice" : "create_prorations";
  const idempotencyKey = `seats:${row.stripeSubscriptionId}:${seats}`;

  logger.info(
    { orgId, seats, previous: row.seatCount, prorationBehavior },
    "billing: updating subscription seat count",
  );
  await billingProvider().setSubscriptionSeats(row.stripeSubscriptionId, {
    seats,
    prorationBehavior,
    idempotencyKey,
  });
  await syncSubscriptionFromStripe(row.stripeSubscriptionId);
}

/**
 * Change an org's plan to any other plan (any tier → any tier).
 *
 * Upgrade path  (target tier higher, or the SAME tier — meetsMinimumTier treats
 *   a lateral move as an upgrade): swap price immediately and invoice the
 *   proration now.
 * Downgrade path (target tier lower): swap price with proration_behavior
 *   'none' — the new, lower price applies from the next cycle and NO proration
 *   line is written, so the customer is not credited for the unused remainder
 *   of the tier they are leaving.
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
  // billing.plans is a shared platform catalog (no org_id, RLS not enabled) —
  // read via withSystemDb to match the catalog-read convention used everywhere
  // else (public-plans.ts, subscription/page.tsx). billing.subscriptions IS
  // org-scoped under RLS, so it stays on withTenantDb.
  const [targetPlan, activeSubRow] = await Promise.all([
    withSystemDb((tx) =>
      tx.query.plans.findFirst({
        where: eq(schema.plans.slug, targetPlanSlug),
        columns: {
          id: true,
          tier: true,
          stripePriceIdMonthly: true,
          stripePriceIdAnnual: true,
        },
      }),
    ),
    // billing.subscriptions IS org-scoped — keep it tenant-scoped under RLS.
    withTenantDb((tx) =>
      tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing')`,
        ),
        columns: {
          stripeSubscriptionId: true,
          seatCount: true,
          planId: true,
        },
      }),
    ),
  ]);

  if (!targetPlan) throw new Error(`Plan '${targetPlanSlug}' not found`);

  const newPriceId =
    interval === "year"
      ? targetPlan.stripePriceIdAnnual
      : targetPlan.stripePriceIdMonthly;
  if (!newPriceId)
    throw new Error(`Plan '${targetPlanSlug}' has no ${interval} price`);

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

  // Resolve current plan tier for proration decision. Shared catalog (no RLS) → system.
  const currentPlanRow = await withSystemDb((tx) =>
    tx.query.plans.findFirst({
      where: eq(schema.plans.id, activeSubRow.planId),
      columns: { tier: true },
    }),
  );

  // Active subscription — swap the price in-place.
  // Determine proration behavior by comparing tier order.
  const isUpgrade = checkPlanTier(
    targetPlan.tier,
    currentPlanRow?.tier || "free",
  );
  const prorationBehavior: "always_invoice" | "none" = isUpgrade
    ? "always_invoice"
    : "none";

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

  await upgradeSubscription(
    activeSub.stripeSubscriptionId,
    newPriceId,
    prorationBehavior,
  );

  // SOC2 audit: an org's plan tier changed on an active subscription (upgrade
  // OR downgrade) — a privileged billing mutation. The no-active-sub branch
  // above returns a Checkout URL and does NOT change a plan in place, so it is
  // not emitted here (the resulting checkout.session.completed webhook syncs a
  // brand-new subscription). Fire-and-forget — never blocks the swap.
  emitSecurityEvent({
    eventType: "billing.plan_changed",
    actorUserId: null,
    orgId,
    workspaceId: null,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  // Preserve seat count: if current seatCount > 1, update the quantity after
  // the price swap. upgradeSubscription keeps the same item, so quantity persists
  // through the price swap automatically — no extra call needed.

  // After a successful in-place upgrade, grant prorated plan upgrade credits.
  if (isUpgrade) {
    try {
      const { grantProratedPlanUpgradeCredits } = await import("./grants");
      await grantProratedPlanUpgradeCredits(
        orgId,
        activeSub.planId,
        targetPlan.id,
      );
    } catch (err) {
      // Grant failure must never fail the plan swap — log and continue.
      logger.error(
        { orgId, fromPlanId: activeSub.planId, toPlanId: targetPlan.id, err },
        "billing: grantProratedPlanUpgradeCredits failed after plan swap — continuing",
      );
    }
  }

  return null;
}

// ── SeatChangePreview ─────────────────────────────────────────────────────────

export interface SeatChangePreview {
  currentSeats: number;
  requestedSeats: number;
  direction: "increase" | "decrease" | "none";
  amountCents: number; // >0 = charge now; <0 = credit next cycle
  isCharge: boolean;
  isCredit: boolean;
  currency: string;
  /** The default card that WOULD be charged; null if none on file. */
  card: { brand: string | null; last4: string | null } | null;
  prorationDate: number;
  /** Present when seats < current usage (decrease blocked by headcount). */
  blocked?: {
    code: "seat_limit_reached";
    licenses: number;
    used: number;
  };
}

/**
 * Simulate a seat-count change and return what WOULD be charged/credited —
 * without applying it. Drives the confirm-before-charge UI step.
 *
 * - direction increase: proration 'always_invoice' (charge now).
 * - direction decrease: proration 'create_prorations' (credit next cycle).
 * - direction none: returns amountCents=0 immediately (no provider call needed).
 * - Decrease below current usage: returns `blocked` instead of throwing.
 */
export async function previewSeatChange(
  orgId: string,
  seats: number,
): Promise<SeatChangePreview> {
  const start = Date.now();
  if (seats < 1) throw new Error("seats must be >= 1");

  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} IN ('active','trialing')`,
      ),
      columns: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        seatCount: true,
      },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);

  const currentSeats = row.seatCount;
  const direction: "increase" | "decrease" | "none" =
    seats > currentSeats
      ? "increase"
      : seats < currentSeats
        ? "decrease"
        : "none";

  // No-change path — no provider call needed.
  if (direction === "none") {
    logger.debug({ orgId, seats }, "billing: previewSeatChange — no change");
    return {
      currentSeats,
      requestedSeats: seats,
      direction: "none",
      amountCents: 0,
      isCharge: false,
      isCredit: false,
      currency: "usd",
      card: null,
      prorationDate: Math.floor(Date.now() / 1000),
    };
  }

  // Decrease guard: if seats < current usage, return blocked (do NOT throw).
  if (direction === "decrease") {
    const usage = await getOrgSeatUsage(orgId);
    if (seats < usage.used) {
      logger.warn(
        { orgId, requestedSeats: seats, used: usage.used },
        "billing: previewSeatChange — decrease blocked by seat usage",
      );
      return {
        currentSeats,
        requestedSeats: seats,
        direction: "decrease",
        amountCents: 0,
        isCharge: false,
        isCredit: false,
        currency: "usd",
        card: null,
        prorationDate: Math.floor(Date.now() / 1000),
        blocked: {
          code: "seat_limit_reached",
          licenses: usage.licenses,
          used: usage.used,
        },
      };
    }
  }

  const prorationBehavior =
    direction === "increase" ? "always_invoice" : "create_prorations";

  const preview = await billingProvider().previewSeatChange(
    row.stripeSubscriptionId,
    { seats, prorationBehavior },
  );

  // Resolve default card details for the confirmation step.
  let card: { brand: string | null; last4: string | null } | null = null;
  try {
    const provider = billingProvider();
    const defaultPmId = await provider.getDefaultPaymentMethodId(
      row.stripeCustomerId,
    );
    if (defaultPmId) {
      const methods = await provider.listPaymentMethods(row.stripeCustomerId);
      const pm = methods.find((m) => m.id === defaultPmId);
      if (pm) card = { brand: pm.brand, last4: pm.last4 };
    }
  } catch (err) {
    logger.warn(
      { orgId, err },
      "billing: could not resolve default card for seat preview",
    );
  }

  logger.info(
    {
      orgId,
      currentSeats,
      requestedSeats: seats,
      direction,
      amountCents: preview.amountCents,
      durationMs: Date.now() - start,
    },
    "billing: seat change preview computed",
  );

  return {
    currentSeats,
    requestedSeats: seats,
    direction,
    amountCents: preview.amountCents,
    isCharge: preview.isCharge,
    isCredit: preview.amountCents < 0,
    currency: preview.currency,
    card,
    prorationDate: preview.prorationDate,
  };
}

// ── PlanChangePreview ─────────────────────────────────────────────────────────

export interface PlanChangePreview {
  targetPlanSlug: string;
  interval: "month" | "year";
  amountCents: number;
  isCharge: boolean;
  currency: string;
  /** The default card that WOULD be charged; null if none on file. */
  card: { brand: string | null; last4: string | null } | null;
  prorationDate: number;
  /**
   * True when the org has no active subscription — the upgrade MUST go through
   * Stripe Checkout rather than an in-place price swap.
   */
  requiresCheckout: boolean;
}

/**
 * Simulate a plan change and return what WOULD be charged/credited.
 *
 * - No active subscription: requiresCheckout=true, amountCents = full plan price.
 * - Active subscription + upgrade: proration 'always_invoice'.
 * - Active subscription + downgrade: proration 'none' (no immediate charge).
 */
export async function previewPlanChange(
  orgId: string,
  targetPlanSlug: string,
  interval: "month" | "year",
): Promise<PlanChangePreview> {
  const start = Date.now();

  // billing.plans is a shared platform catalog (no org_id, RLS not enabled) →
  // read via withSystemDb; billing.subscriptions is org-scoped → withTenantDb.
  const [targetPlan, activeSub] = await Promise.all([
    withSystemDb((tx) =>
      tx.query.plans.findFirst({
        where: eq(schema.plans.slug, targetPlanSlug),
        columns: {
          id: true,
          tier: true,
          stripePriceIdMonthly: true,
          stripePriceIdAnnual: true,
          monthlyCents: true,
          annualCents: true,
        },
      }),
    ),
    withTenantDb((tx) =>
      tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing')`,
        ),
        columns: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          planId: true,
        },
      }),
    ),
  ]);

  if (!targetPlan) throw new Error(`Plan '${targetPlanSlug}' not found`);

  const newPriceId =
    interval === "year"
      ? targetPlan.stripePriceIdAnnual
      : targetPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(`Plan '${targetPlanSlug}' has no ${interval} price`);
  }

  // Full plan price for checkout scenario.
  // `annualCents` is nullable in the DB schema (plans with no annual price have
  // annualCents = null). Falling back to monthlyCents when annualCents is null
  // would quote the customer the monthly price (~10× too low) while Stripe charges
  // the actual annual price — a deceptive UI and chargeback risk.
  // Throw explicitly so misconfigured plans are caught before any checkout session
  // is created rather than silently misleading the customer.
  if (interval === "year" && targetPlan.annualCents === null) {
    throw new Error(
      `Plan '${targetPlanSlug}' has no annualCents configured; cannot preview annual subscription price`,
    );
  }
  const fullPriceCents =
    interval === "year"
      ? (targetPlan.annualCents as number)
      : targetPlan.monthlyCents;

  // Helper: resolve default card.
  async function resolveDefaultCard(
    customerId: string,
  ): Promise<{ brand: string | null; last4: string | null } | null> {
    try {
      const provider = billingProvider();
      const defaultPmId = await provider.getDefaultPaymentMethodId(customerId);
      if (!defaultPmId) return null;
      const methods = await provider.listPaymentMethods(customerId);
      const pm = methods.find((m) => m.id === defaultPmId);
      return pm ? { brand: pm.brand, last4: pm.last4 } : null;
    } catch (err) {
      logger.warn(
        { orgId, err },
        "billing: could not resolve default card for plan preview",
      );
      return null;
    }
  }

  if (!activeSub) {
    // No active subscription → Checkout path. Use the full plan price.
    // Resolve the customer id for card lookup (may not exist yet).
    let card: { brand: string | null; last4: string | null } | null = null;
    try {
      const customerId = await resolveCustomerId(orgId);
      card = await resolveDefaultCard(customerId);
    } catch (err) {
      // resolveCustomerId either returns a customer id or throws (there is no
      // distinguishable "not found" signal — ensureStripeCustomer creates the
      // customer or fails on a real Stripe error). So we can't cleanly separate
      // the expected "no customer yet" case from an auth/outage/rate-limit
      // incident. Log every caught error rather than silently claiming "no card
      // on file" during an outage, but preserve the no-card fallback so the
      // preview still renders.
      logger.warn(
        { orgId, err },
        "billing: plan-change preview card lookup failed — proceeding as no card",
      );
    }

    const prorationDate = Math.floor(Date.now() / 1000);

    logger.info(
      {
        orgId,
        targetPlanSlug,
        interval,
        requiresCheckout: true,
        durationMs: Date.now() - start,
      },
      "billing: plan change preview — no active sub, checkout required",
    );

    return {
      targetPlanSlug,
      interval,
      amountCents: fullPriceCents,
      isCharge: true,
      currency: "usd",
      card,
      prorationDate,
      requiresCheckout: true,
    };
  }

  // Active subscription — in-place swap preview. Shared catalog (no RLS) → system.
  const currentPlanRow = await withSystemDb((tx) =>
    tx.query.plans.findFirst({
      where: eq(schema.plans.id, activeSub.planId),
      columns: { tier: true },
    }),
  );

  const isUpgrade = checkPlanTier(
    targetPlan.tier,
    currentPlanRow?.tier || "free",
  );
  const prorationBehavior: "always_invoice" | "none" = isUpgrade
    ? "always_invoice"
    : "none";

  const preview = await billingProvider().previewPlanChange(
    activeSub.stripeSubscriptionId,
    { newPriceId, prorationBehavior },
  );

  const card = await resolveDefaultCard(activeSub.stripeCustomerId);

  logger.info(
    {
      orgId,
      targetPlanSlug,
      interval,
      isUpgrade,
      amountCents: preview.amountCents,
      requiresCheckout: false,
      durationMs: Date.now() - start,
    },
    "billing: plan change preview computed",
  );

  return {
    targetPlanSlug,
    interval,
    amountCents: preview.amountCents,
    isCharge: preview.isCharge,
    currency: preview.currency,
    card,
    prorationDate: preview.prorationDate,
    requiresCheckout: false,
  };
}

// ── Internal helper used by previewPlanChange ────────────────────────────────

async function resolveCustomerId(orgId: string): Promise<string> {
  const sub = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.orgId, orgId),
      columns: { stripeCustomerId: true },
    }),
  );
  if (sub?.stripeCustomerId) return sub.stripeCustomerId;
  const { ensureStripeCustomer } = await import("./customers");
  return ensureStripeCustomer(orgId);
}
