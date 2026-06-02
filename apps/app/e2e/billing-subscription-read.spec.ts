import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { loginAs } from "./helpers/auth";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

// ─── Billing — subscription + credit read path ───────────────────────────────
//
// Verifies that the `/billing/subscription` page renders real, DB-backed
// billing state for an authenticated org.
//
// Seeding: the agent-runtime fixture provides the org + user + session. On top
// of that, this spec seeds:
//   • A `billing.plans` row (the "Build" plan, slug "build").
//   • A `billing.subscriptions` row with status "active".
//   • A `billing.credit_balances` row with a known non-zero balance.
//   • Two `billing.credit_ledger` entries so the ledger drawer has content.
//
// Assertions:
//   • The SubscriptionSummary card renders "Current subscription" with
//     the plan name and status badge.
//   • The CreditBalance card renders the correct formatted balance.
//   • After clicking "Recent ledger entries", seeded ledger reasons appear.
//   • The PlansGrid renders at least one plan card.
//
// The spec also keeps the baseline auth-guard assertion so the file covers
// both paths.

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);

const BILLING_ORG_SLUG = "e2e-billing";
const BILLING_WS_SLUG = "main";
const BILLING_USER_EMAIL = "e2e+billing@oxagen.ai";

// Deterministic IDs for the billing rows so reruns are idempotent.
const IDS = {
  plan: "00000000-b111-0000-0000-000000000001",
  subscription: "00000000-b111-0000-0000-000000000002",
  creditBalance: "00000000-b111-0000-0000-000000000003",
  ledger1: "00000000-b111-0000-0000-000000000004",
  ledger2: "00000000-b111-0000-0000-000000000005",
} as const;

// $20/mo = 2000 cents; credit balance: $47.50 = 4750 cents.
const BALANCE_CENTS = 4750;
const PLAN_NAME = "Build";
const PLAN_SLUG = "build";

let billingFixture: AgentRuntimeFixture;

test.describe("billing.subscription.read — auth guard", () => {
  test("unauthenticated visit to billing page redirects to /login", async ({ page }) => {
    await page.goto("/acme/billing/subscription");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("billing.subscription.read — authenticated, seeded state", () => {
  test.beforeAll(async () => {
    billingFixture = await setupAgentRuntimeFixture({
      orgSlug: BILLING_ORG_SLUG,
      workspaceSlug: BILLING_WS_SLUG,
      userEmail: BILLING_USER_EMAIL,
    });

    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      // Seed a public plan (matches the plans.isPublic=true query in the page).
      await sql`
        INSERT INTO billing.plans (
          id, public_id, name, slug, tier,
          stripe_product_id,
          monthly_cents, annual_cents,
          included_credit_cents, included_seats,
          is_public, features
        )
        VALUES (
          ${IDS.plan}::uuid,
          'pln_e2e_build',
          ${PLAN_NAME},
          ${PLAN_SLUG},
          'build',
          'prod_e2e_build',
          2000, 20000,
          500, 3,
          true,
          '{"list":["Unlimited workspaces","Priority support","3 seats"]}'::jsonb
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Seed an active subscription for the org under this plan.
      await sql`
        INSERT INTO billing.subscriptions (
          id, public_id, org_id, plan_id,
          stripe_subscription_id, stripe_customer_id,
          status, billing_interval, seat_count,
          current_period_start, current_period_end,
          cancel_at_period_end
        )
        VALUES (
          ${IDS.subscription}::uuid,
          'sub_e2e_build',
          ${billingFixture.orgId},
          ${IDS.plan}::uuid,
          'sub_stripe_e2e_build',
          'cus_stripe_e2e_build',
          'active',
          'month',
          2,
          now() - interval '10 days',
          now() + interval '20 days',
          false
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Seed a credit balance.
      await sql`
        INSERT INTO billing.credit_balances (id, public_id, org_id, balance_cents)
        VALUES (
          ${IDS.creditBalance}::uuid,
          'cbl_e2e_billing',
          ${billingFixture.orgId},
          ${BALANCE_CENTS}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Seed two ledger entries.
      await sql`
        INSERT INTO billing.credit_ledger (id, public_id, org_id, delta_cents, reason)
        VALUES
          (
            ${IDS.ledger1}::uuid,
            'cle_e2e_001',
            ${billingFixture.orgId},
            500,
            'Subscription credit grant'
          ),
          (
            ${IDS.ledger2}::uuid,
            'cle_e2e_002',
            ${billingFixture.orgId},
            -50,
            'Agent run usage'
          )
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => {
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`DELETE FROM billing.credit_ledger WHERE id IN (
        ${IDS.ledger1}::uuid, ${IDS.ledger2}::uuid
      )`;
      await sql`DELETE FROM billing.credit_balances WHERE id = ${IDS.creditBalance}::uuid`;
      await sql`DELETE FROM billing.subscriptions WHERE id = ${IDS.subscription}::uuid`;
      await sql`DELETE FROM billing.plans WHERE id = ${IDS.plan}::uuid`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await teardownFixture({ orgSlug: BILLING_ORG_SLUG });
  });

  test("subscription summary card renders plan name and active badge", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, billingFixture.sessionToken, baseURL);
    await page.goto(`/${BILLING_ORG_SLUG}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // SubscriptionSummary — heading for active subscription.
    await expect(page.getByText("Current subscription")).toBeVisible();

    // Plan name from seeded data.
    await expect(page.getByText(PLAN_NAME)).toBeVisible();

    // Status badge — "active".
    await expect(page.getByText(/^active$/i)).toBeVisible();

    // Billing interval — "Monthly".
    await expect(page.getByText(/monthly/i)).toBeVisible();
  });

  test("credit balance card renders the seeded balance", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, billingFixture.sessionToken, baseURL);
    await page.goto(`/${BILLING_ORG_SLUG}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // CreditBalance heading.
    await expect(page.getByText(/credit balance/i)).toBeVisible();

    // The balance is $47.50 — formatCents renders it as "$47.50".
    await expect(page.getByText(/\$47\.50/)).toBeVisible();
  });

  test("ledger drawer reveals seeded entries when expanded", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, billingFixture.sessionToken, baseURL);
    await page.goto(`/${BILLING_ORG_SLUG}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // Open the ledger drawer.
    await page.getByRole("button", { name: /recent ledger entries/i }).click();

    // Both seeded reason strings must be visible.
    await expect(page.getByText("Subscription credit grant")).toBeVisible();
    await expect(page.getByText("Agent run usage")).toBeVisible();
  });

  test("plans grid renders at least one plan card", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, billingFixture.sessionToken, baseURL);
    await page.goto(`/${BILLING_ORG_SLUG}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // PlansGrid renders `data-component="plan-card"` or falls back to role
    // "article" / heading containing the plan name. Assert the seeded plan
    // name is visible in the plans section.
    await expect(page.getByText(PLAN_NAME).first()).toBeVisible();
  });
});
