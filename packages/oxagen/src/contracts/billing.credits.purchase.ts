import { z } from "zod";
import { registerCapability } from "../registry";

// Initiate a dynamic usage-credit purchase via Stripe Checkout.
// The customer specifies how much usage (in USD) they want to buy; the volume
// discount is applied automatically. They receive the full face-value in credits
// but pay a discounted price. The Stripe webhook landing at apps/api will
// deposit the credits after payment via grantCreditPackForCheckout.
export const billingCreditsPurchase = registerCapability({
  name: "purchase_credits",
  domain: "billing",
  description:
    "Start a Stripe Checkout session for a dynamic usage-credit purchase; returns a URL the customer opens to complete payment",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "billing" },
  sensitivity: "high",
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
    amountUsd: z.number().positive().min(5, "Minimum purchase is $5"),
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
