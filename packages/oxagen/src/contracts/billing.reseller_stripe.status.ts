import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * get_reseller_stripe_status — whether the org has connected a reseller Stripe
 * key, plus the non-secret fingerprint. Drives the "connect your account" empty
 * state and the push affordance. Never returns the key itself.
 */
export const resellerStripeStatus = registerCapability({
  name: "get_reseller_stripe_status",
  domain: "billing",
  description:
    "Report whether a reseller Stripe key is connected for the org, with its label and last-4 fingerprint. Never returns the key.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    accountLabel: z.string().nullable(),
    keyLast4: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
});

export type ResellerStripeStatusInput = z.output<
  typeof resellerStripeStatus.input
>;
export type ResellerStripeStatusOutput = z.output<
  typeof resellerStripeStatus.output
>;
