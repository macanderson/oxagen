/**
 * seed-subscription.ts — DB helper to simulate a post-payment subscription.
 *
 * Inserts an active billing.subscriptions row for the given org, standing in
 * for the Stripe webhook that would otherwise create it. This lets e2e tests
 * exercise the post-payment Members UI without a real Stripe integration.
 *
 * Uses a fresh postgres connection (not the shared pool) so it's safe to call
 * from parallel test workers without contention.
 */

import postgres from "postgres";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

export interface SeedSubscriptionOpts {
  orgId: string;
  /**
   * Plan slug. Defaults to the canonical `build-v2` so the seeded row passes the
   * billing UI's source-of-truth slug filter (see billing/public-plans.ts) — a
   * legacy un-suffixed slug would be filtered out and never render.
   */
  planSlug?: string;
  /** Plan name shown in the UI. */
  planName?: string;
  seatCount?: number;
  billingInterval?: "month" | "year";
}

export interface SeededSubscription {
  planId: string;
  subscriptionId: string;
  /** Call this to remove the rows this helper created. */
  cleanup: () => Promise<void>;
}

/**
 * Seed an active Build-tier subscription for the given org.
 * Creates the billing.plans row if it doesn't exist yet.
 * Returns cleanup() so callers can optionally tear down.
 */
export async function seedSubscription(
  opts: SeedSubscriptionOpts,
): Promise<SeededSubscription> {
  const {
    orgId,
    planSlug = "build-v2",
    planName = "Build",
    seatCount = 5,
    billingInterval = "month",
  } = opts;

  // tier must satisfy the billing.plans CHECK (free|build|scale|enterprise); the
  // slug carries the `-v2` product-version suffix, the tier does not.
  const tier = planSlug.replace(/-v2$/, "");

  const sql = postgres(DATABASE_URL, { max: 2, prepare: false });

  try {
    // Upsert a public plan row so the page's plans grid can render it.
    const [planRow] = await sql<{ id: string }[]>`
      INSERT INTO billing.plans (
        public_id, name, slug, tier,
        stripe_product_id,
        monthly_cents, annual_cents,
        included_credit_cents, included_seats,
        is_public, features
      )
      VALUES (
        ${"pln_e2e_" + planSlug + "_" + orgId.slice(-8)},
        ${planName},
        ${planSlug},
        ${tier},
        ${"prod_e2e_" + planSlug},
        2000, 20000,
        500, ${seatCount},
        true,
        ${'{"list":["5 seats","Unlimited workspaces","Priority support"]}'}::jsonb
      )
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name, included_seats = EXCLUDED.included_seats
      RETURNING id
    `;

    if (!planRow)
      throw new Error("seed-subscription: plan upsert returned no row");
    const planId = planRow.id;

    // Deactivate any existing subscription to avoid duplicate-active confusion.
    await sql`
      UPDATE billing.subscriptions
      SET status = 'canceled'
      WHERE org_id = ${orgId}
        AND status IN ('active', 'trialing', 'past_due')
    `;

    const [subRow] = await sql<{ id: string }[]>`
      INSERT INTO billing.subscriptions (
        public_id, org_id, plan_id,
        stripe_subscription_id, stripe_customer_id,
        status, billing_interval, seat_count,
        current_period_start, current_period_end,
        cancel_at_period_end
      )
      VALUES (
        ${"sub_e2e_" + orgId.slice(-8)},
        ${orgId},
        ${planId},
        ${"sub_stripe_e2e_" + orgId.slice(-8)},
        ${"cus_stripe_e2e_" + orgId.slice(-8)},
        'active',
        ${billingInterval},
        ${seatCount},
        now() - interval '5 days',
        now() + interval '25 days',
        false
      )
      ON CONFLICT (public_id) DO UPDATE
        SET status = 'active', seat_count = EXCLUDED.seat_count
      RETURNING id
    `;

    if (!subRow)
      throw new Error("seed-subscription: subscription insert returned no row");
    const subscriptionId = subRow.id;

    const cleanup = async () => {
      const cleanSql = postgres(DATABASE_URL, { max: 1, prepare: false });
      try {
        await cleanSql`DELETE FROM billing.subscriptions WHERE id = ${subscriptionId}`;
        // Leave the plan row — it may be shared across workers.
      } finally {
        await cleanSql.end({ timeout: 5 });
      }
    };

    return { planId, subscriptionId, cleanup };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
