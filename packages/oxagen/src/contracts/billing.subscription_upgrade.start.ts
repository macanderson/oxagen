import { z } from "zod";
import { registerCapability } from "../registry";

// Begin a Stripe Checkout flow for a plan change. The capability does not
// complete the upgrade itself — Stripe Checkout is hosted, and the
// subscription only flips after Stripe's `customer.subscription.updated`
// webhook lands at apps/api `/webhooks/stripe`. The agent invokes this
// capability, receives a URL, and either redirects the user (in-app) or
// links it (MCP / API). User approval is required regardless of surface.
/**
 * The plans the Billing page's Change plan dialog offers, and the published
 * figures its price list prints (apps/app/ARCHITECTURE.md §1.4; maintainer
 * decision of 2026-09-15). Enterprise is not here: it is negotiated on a
 * `billing.contract_terms` row and has no plan in Stripe or in the dialog.
 *
 * The figures live on the contract because `apps/app` may import
 * `@oxagen/oxagen/contracts/*` and nothing else from the platform (§2,
 * INV-03), and `packages/oxagen` cannot import `@oxagen/billing` without a
 * cycle. `pricing.test.ts` in `@oxagen/billing` compares them with
 * `SUBSCRIPTION_PLANS`, `ACTION_RATE_BANDS` and `FREE_SIGNUP_CREDITS` and
 * fails when they drift, so this is not a second price schedule.
 */
export const UPGRADE_PLANS = [
  {
    slug: "build-v2",
    tier: "build",
    monthlyCents: 19_900,
    annualCents: 199_000,
    includedGauPerMonth: 50_000,
  },
  {
    slug: "scale-v2",
    tier: "scale",
    monthlyCents: 99_900,
    annualCents: 999_000,
    includedGauPerMonth: 300_000,
  },
] as const;

export type UpgradePlan = (typeof UPGRADE_PLANS)[number];

/** The published governed-action terms every tier shares, and the in-app usage grant. */
export const PUBLISHED_TERMS = {
  /** GAUs a Free organization is given each month (ADR-055 §2). */
  freeIncludedGauPerMonth: 5_000,
  /** The list rate: 5,000 micros, $5 per 1,000 GAU. */
  ratePerGauMicros: 5_000,
  /** GAUs in one purchased block. */
  blockSizeGau: 5_000,
  /** The volume bands, USD per 1,000 GAU, by annual volume. */
  volumeBandsUsdPer1000: [5, 4, 3, 2],
  /** The usage credits `create_org` grants a new organization; 1 credit = $0.01. */
  signupGrantCredits: 500,
} as const;

export const billingSubscriptionUpgradeStart = registerCapability({
  name: "start_subscription_upgrade",
  domain: "billing",
  description:
    "Start a Stripe Checkout session for a plan change; returns a URL the user opens to complete the upgrade",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  // INV-27: changing plan is never refused for lack of GAUs. A prepaid org
  // at remaining = 0 is the one that needs to upgrade; metering the Checkout
  // start as a governed action blocked that path (apps/app/ARCHITECTURE.md
  // §1.5). purchase_gau_bucket and purchase_credits already declare this.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "billing" },
  sensitivity: "high",
  // Opens a Stripe Checkout session, and creates the org's Stripe customer
  // first when it has none.
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({
    planSlug: z.string().min(1),
    interval: z.enum(["month", "year"]),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  }),
  output: z.object({
    checkoutUrl: z.string().url(),
    planSlug: z.string(),
    interval: z.enum(["month", "year"]),
  }),
});

export type BillingSubscriptionUpgradeStartInput = z.output<
  typeof billingSubscriptionUpgradeStart.input
>;
export type BillingSubscriptionUpgradeStartOutput = z.output<
  typeof billingSubscriptionUpgradeStart.output
>;
