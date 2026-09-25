import { z } from "zod";
import { registerCapability } from "../registry";
import type { PlanTier } from "../types";

// Initiate a dynamic usage-credit purchase via Stripe Checkout.
// The customer specifies how much usage (in USD) they want to buy; the volume
// discount is applied automatically. They receive the full face-value in credits
// but pay a discounted price. The Stripe webhook landing at apps/api will
// deposit the credits after payment via grantCreditPackForCheckout.

/** The smallest top-up, in whole dollars of face value. */
export const MIN_CREDIT_TOPUP_USD = 5;

/**
 * The top-up amounts the Billing page offers as presets, in whole dollars of
 * face value (apps/app/ARCHITECTURE.md §1.4, the In-app AI usage row).
 *
 * They are the `CREDIT_PACKS` prices (`packages/billing/src/pricing.ts`), the
 * one price schedule for usage credits; `pricing.test.ts` compares the two and
 * fails when they drift, so this list cannot become a second schedule.
 *
 * The list lives on the contract because `apps/app` may import
 * `@oxagen/oxagen/contracts/*` and nothing else from the platform (§2,
 * INV-03), and `packages/oxagen` cannot import `@oxagen/billing` — billing
 * depends on oxagen, so reading the packs here would be a cycle.
 */
export const CREDIT_TOPUP_PRESETS_USD: readonly number[] = [10, 50, 200];

/**
 * Whether an organization on `tier` may buy usage credits at all. A Free
 * organization may not: it subscribes to Build or above first, so a top-up it
 * starts is refused by `createUsageCreditCheckout` before Stripe is reached.
 *
 * The rule lives on the contract for the same reason the presets do — the
 * Billing page has to know it to decide whether to offer the top-up or the
 * upgrade path, and `apps/app` may import `@oxagen/oxagen/contracts/*` and
 * nothing else from the platform (§2, INV-03). `canBuyCredits` in
 * `@oxagen/billing`, which the handler's checkout path consults, delegates
 * here, so the page and the checkout cannot answer differently.
 */
export function canTierBuyCredits(tier: PlanTier): boolean {
  return tier !== "free";
}

export const billingCreditsPurchase = registerCapability({
  name: "purchase_credits",
  domain: "billing",
  description:
    "Start a Stripe Checkout session for a dynamic usage-credit purchase; returns a URL the customer opens to complete payment",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "billing" },
  sensitivity: "high",
  // Opens a Stripe Checkout session, and creates the org's Stripe customer
  // first when it has none.
  mutates: true,
  // INV-27 (ADR-052 exclusion 2, ARCHITECTURE.md §1.5, §3.9 the second meter):
  // topping up is never refused for lack of governed action units. Without the
  // flag a credit top-up is itself a governed action, so a prepaid org whose
  // GAU bucket is at `remaining <= 0` is refused `gau_exhausted` when it tries
  // to buy the credits that would let the in-app agent run again.
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({
    /**
     * The face-value dollar amount of usage credits the customer wants to
     * purchase, e.g. 50 for $50. Must be ≥ 5 (= $5 minimum).
     * 1 credit = 1¢, so amountUsd * 100 = credits granted.
     */
    amountUsd: z
      .number()
      .positive()
      .min(MIN_CREDIT_TOPUP_USD, "Minimum purchase is $5"),
    /**
     * Optional Stripe Checkout success redirect URL. When omitted the handler
     * falls back to the billing package default.
     */
    successUrl: z.string().url().optional(),
    /**
     * Optional Stripe Checkout cancel redirect URL. When omitted the handler
     * falls back to the billing package default.
     */
    cancelUrl: z.string().url().optional(),
  }),
  output: z.object({
    /** Stripe Checkout URL to redirect the customer to. */
    url: z.string().url(),
    /** Face-value credits the customer will receive (amountUsd × 100). */
    grantCents: z.number().int().positive(),
    /** Amount the customer will actually pay, in USD cents (after discount). */
    priceCents: z.number().int().positive(),
    /** Discount percentage applied, e.g. 15 for 15% off. 0 when no discount. */
    percent: z.number().nonnegative(),
  }),
});

export type BillingCreditsPurchaseInput = z.output<
  typeof billingCreditsPurchase.input
>;
export type BillingCreditsPurchaseOutput = z.output<
  typeof billingCreditsPurchase.output
>;
