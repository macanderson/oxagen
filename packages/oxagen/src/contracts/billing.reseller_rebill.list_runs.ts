import { z } from "zod";
import { registerCapability } from "../registry";
import { resellerRebillRunSchema } from "./reseller-shared";

/**
 * list_reseller_rebill_runs — the historical per-customer usage→revenue view:
 * every push attempt with its period, totals, provider invoice, and status.
 */
export const resellerRebillListRuns = registerCapability({
  name: "list_reseller_rebill_runs",
  domain: "billing",
  description:
    "List past reseller re-bill runs (period, subtotal, billed total, Stripe invoice, status), most recent first. Optionally filter to one customer.",
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
  input: z.object({
    customerId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ runs: z.array(resellerRebillRunSchema) }),
});

export type ResellerRebillListRunsInput = z.output<
  typeof resellerRebillListRuns.input
>;
export type ResellerRebillListRunsOutput = z.output<
  typeof resellerRebillListRuns.output
>;
