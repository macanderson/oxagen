import { z } from "zod";
import { registerCapability } from "../registry.js";

export const billingSubscriptionRead = registerCapability({
  name: "billing.subscription.read",
  domain: "billing",
  description: "Read the current subscription, plan, and period bounds for the active tenant",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "billing",
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
  }),
});

export type BillingSubscriptionReadInput = z.infer<typeof billingSubscriptionRead.input>;
export type BillingSubscriptionReadOutput = z.infer<typeof billingSubscriptionRead.output>;
