import { z } from "zod";
import { registerCapability } from "../registry";
import { routingStatRowSchema } from "./router-schema";

// `list_routing_stats` is the Pareto-curve read: per (task class, model), the
// observed verified-success rate and cost/latency over a window, plus a derived
// "cheapest model that currently clears the bar" summary per task class. This is
// how a human sees what the router has learned and would do. Read-only.
export const routerStatsList = registerCapability({
  name: "list_routing_stats",
  domain: "router",
  description:
    "List observed market-router outcomes per (task class, model) — samples, verified-success rate, average cost and latency — over a window, plus a derived per-class summary of the cheapest model currently clearing the verified-success bar. The Pareto-curve read.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({
    // Restrict to one task class; omit for every class.
    taskClass: z.string().optional(),
    // Trailing window in days; omit ⇒ the effective policy's windowDays.
    windowDays: z.number().int().positive().optional(),
    // Minimum samples for a (class, model) group; omit ⇒ the policy's minSamples.
    minSamples: z.number().int().nonnegative().optional(),
  }),
  output: z.object({
    rows: z.array(routingStatRowSchema),
    // Cheapest model currently clearing the bar, per task class.
    summary: z.array(
      z.object({
        taskClass: z.string(),
        /** The cheapest eligible model, or null when none clears the bar yet. */
        cheapestEligibleModel: z.string().nullable(),
        verifiedRate: z.number().nullable(),
        avgCostUsdMicros: z.number().nullable(),
        /** How many (class, model) groups were considered for this class. */
        candidateCount: z.number().int().nonnegative(),
        /** How many of them are eligible under the effective policy. */
        eligibleCount: z.number().int().nonnegative(),
      }),
    ),
    // The window + thresholds the read was computed under (echoed for clarity).
    window: z.object({
      windowDays: z.number().int().positive(),
      minSamples: z.number().int().nonnegative(),
      successThreshold: z.number(),
    }),
  }),
});

export type RouterStatsListInput = z.output<typeof routerStatsList.input>;
export type RouterStatsListOutput = z.output<typeof routerStatsList.output>;
