import { z } from "zod";
import { registerCapability } from "../registry";

export const billingSubscriptionRead = registerCapability({
  name: "get_subscription",
  domain: "billing",
  description:
    "Read the current subscription, plan, and period bounds for the active tenant",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "billing",
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
    subscription: z
      .object({
        publicId: z.string(),
        status: z.string(),
        planSlug: z.string(),
        billingInterval: z.enum(["month", "year"]),
        currentPeriodStart: z.string(),
        currentPeriodEnd: z.string(),
        cancelAtPeriodEnd: z.boolean(),
        seatCount: z.number().int().nonnegative(),
      })
      .nullable(),
    creditBalanceCents: z.number().int(),
    // Current-period usage snapshot so the billing panel can render token +
    // cost totals without a second round trip.
    periodUsage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedTokens: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
        executions: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
});

export type BillingSubscriptionReadInput = z.output<
  typeof billingSubscriptionRead.input
>;
export type BillingSubscriptionReadOutput = z.output<
  typeof billingSubscriptionRead.output
>;
