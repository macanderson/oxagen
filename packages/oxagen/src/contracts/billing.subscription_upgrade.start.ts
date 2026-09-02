import { z } from "zod";
import { registerCapability } from "../registry";

// Begin a Stripe Checkout flow for a plan change. The capability does not
// complete the upgrade itself — Stripe Checkout is hosted, and the
// subscription only flips after Stripe's `customer.subscription.updated`
// webhook lands at apps/api `/webhooks/stripe`. The agent invokes this
// capability, receives a URL, and either redirects the user (in-app) or
// links it (MCP / API). User approval is required regardless of surface.
export const billingSubscriptionUpgradeStart = registerCapability({
  name: "start_subscription_upgrade",
  domain: "billing",
  description:
    "Start a Stripe Checkout session for a plan change; returns a URL the user opens to complete the upgrade",
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
