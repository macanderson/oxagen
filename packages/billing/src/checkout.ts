import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { stripeClient } from "./client.js";
import { ensureStripeCustomer } from "./customers.js";

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

  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // Carry tenant on the session — the resulting subscription metadata
    // inherits this and lets webhook handlers route without a DB lookup.
    subscription_data: {
      metadata: { org_id: input.orgId, plan_id: plan.id },
    },
    success_url:
      input.successUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.cancelUrl ?? `${env.NEXT_PUBLIC_APP_URL}/billing/plans`,
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id };
}
