import { z } from "zod";
import { registerCapability } from "../registry";
import { isoInstant, resellerRebillRunSchema } from "./reseller-shared";

/**
 * push_reseller_rebill — the money-moving step of the loop: price one customer's
 * attributed usage for a period and create the corresponding invoice in the
 * RESELLER'S OWN Stripe account (built from their connected key), then record the
 * run. Idempotent per (customer, period): re-pushing updates the same run and
 * reuses the same Stripe invoice rather than duplicating it.
 *
 * When no reseller Stripe key is connected the push does not throw — it returns a
 * failed run and `needsStripeConnection: true` so the UI can prompt to connect.
 */
export const resellerRebillPush = registerCapability({
  name: "push_reseller_rebill",
  domain: "billing",
  description:
    "Push a customer's priced usage for a period to the reseller's Stripe account as an invoice, recording the run. Idempotent per customer+period; returns needsStripeConnection when no key is connected.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "billing" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    /** public id of the customer to bill. */
    customerId: z.string().min(1),
    start: isoInstant.describe(
      "ISO-8601 start of the billing period (inclusive)",
    ),
    end: isoInstant.describe("ISO-8601 end of the billing period (exclusive)"),
    /** Finalize (open) the invoice immediately; false leaves a Stripe draft to review. */
    finalize: z.boolean().default(true),
  }),
  output: z.object({
    run: resellerRebillRunSchema,
    /** True when the org has not connected a reseller Stripe key — nothing was pushed. */
    needsStripeConnection: z.boolean(),
  }),
});

export type ResellerRebillPushInput = z.output<typeof resellerRebillPush.input>;
export type ResellerRebillPushOutput = z.output<
  typeof resellerRebillPush.output
>;
