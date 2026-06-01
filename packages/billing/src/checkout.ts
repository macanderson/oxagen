import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { billingProvider } from "./client.js";
import { ensureStripeCustomer } from "./customers.js";
import { resolveOrgTier } from "./tier.js";
import { canBuyCredits, TierDeniedError } from "./entitlements.js";
import { logger } from "./logger.js";

export interface CreateCheckoutSessionInput {
  orgId: string;
  planSlug: string;
  interval: "month" | "year";
  /**
   * Optional overrides. The agent surface needs to route the user back to the
   * chat context that initiated the upgrade; the in-app billing UI keeps the
   * env defaults.
   */
  successUrl?: string;
  cancelUrl?: string;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<{ url: string; sessionId: string }> {
  const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
  const d = db();
  const plan = await d.query.plans.findFirst({
    where: eq(schema.plans.slug, input.planSlug),
  });
  if (!plan) throw new Error(`plan ${input.planSlug} not found`);

  const priceId =
    input.interval === "year" ? plan.stripePriceIdAnnual : plan.stripePriceIdMonthly;
  if (!priceId) {
    throw new Error(`plan ${input.planSlug} has no ${input.interval} price`);
  }

  const customerId = await ensureStripeCustomer(input.orgId);

  const result = await billingProvider().createSubscriptionCheckout({
    customerId,
    priceId,
    subscriptionMetadata: { org_id: input.orgId, plan_id: plan.id },
    successUrl:
      input.successUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: input.cancelUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/plans`,
  });

  logger.info({ orgId: input.orgId, planSlug: input.planSlug, sessionId: result.sessionId }, "billing: created subscription checkout session");
  return result;
}

export interface CreateCreditPackCheckoutInput {
  orgId: string;
  /** Provider price id for the credit pack (from billing.stripe-sync). */
  priceId: string;
  quantity?: number;
  successUrl?: string;
  cancelUrl?: string;
}

/**
 * One-time Checkout for a credit pack. `org_id` rides on the session metadata
 * so the `checkout.session.completed` webhook can deposit the pack's credits
 * via {@link import("./grants.js").grantCreditPackForCheckout}.
 *
 * Plan-tier gate: Free orgs cannot purchase credit packs — they must subscribe
 * to Build or above first. Throws {@link TierDeniedError} when the gate fails
 * so the caller can surface an appropriate upgrade prompt.
 */
export async function createCreditPackCheckoutSession(
  input: CreateCreditPackCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  // ── Credit-purchase entitlement gate ────────────────────────────────────────
  const tier = await resolveOrgTier(input.orgId);
  if (!canBuyCredits(tier)) {
    throw new TierDeniedError(tier, "build", "credit-packs");
  }

  const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
  const customerId = await ensureStripeCustomer(input.orgId);

  const result = await billingProvider().createPaymentCheckout({
    customerId,
    priceId: input.priceId,
    quantity: input.quantity ?? 1,
    metadata: { org_id: input.orgId },
    successUrl:
      input.successUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: input.cancelUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/credits`,
  });

  logger.info({ orgId: input.orgId, priceId: input.priceId, sessionId: result.sessionId }, "billing: created credit-pack checkout session");
  return result;
}
