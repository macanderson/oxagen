import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * preview_action_cost
 *
 * The run → action calculator (spec §3.4).
 *
 * "Governed action" is precise and "run" is legible, and they are not the same
 * word. ADR-052's Consequences section names a published calculator as part of
 * shipping the meter rather than a nicety: a buyer who cannot convert their own
 * volume into a price has been handed a rate card they cannot use.
 *
 * Pure arithmetic over published constants — no organisation data, no DB read.
 * It shows its assumptions in the output (spec §3.4: "the calculator … shows
 * its assumptions"), because a conversion whose ratio is hidden is a quote a
 * buyer cannot check.
 *
 * `noBillingGate: true` — a price estimate is never itself a charge.
 */

export const RUN_CLASSES = [
  "qa_lookup",
  "standard_task",
  "multi_step",
  "long_running",
] as const;

export const billingActionEstimate = registerCapability({
  name: "preview_action_cost",
  domain: "billing",
  description:
    "Convert a projected number of agent runs into governed actions and a price, using the published run-class conversion (spec §3.4) and volume bands (§4.1). Shows the actions-per-run ratio it used, and the tier allowance it applied. Pure arithmetic — no organisation data is read.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Member: "allow",
    },
    workspace: {},
  },
  input: z.object({
    /** Runs the customer expects per year. */
    runsPerYear: z
      .number()
      .int()
      .positive()
      .max(1_000_000_000)
      .describe("Projected agent runs per year"),
    /**
     * Which run class those runs look like. Drives the actions-per-run ratio
     * from spec §3.4. Defaults to the standard task, the middle of the range.
     */
    runClass: z.enum(RUN_CLASSES).optional().default("standard_task"),
    /**
     * Override the actions-per-run ratio directly, for a customer who has
     * measured their own. Wins over `runClass` when both are given — a measured
     * ratio beats a published typical one.
     */
    actionsPerRun: z.number().positive().max(10_000).optional(),
    /** Tier to price against. Defaults to `scale`. */
    tier: z.enum(["free", "build", "scale", "enterprise"]).optional(),
  }),
  output: z.object({
    /** The ratio actually used, and where it came from. */
    assumptions: z.object({
      runsPerYear: z.number().int().positive(),
      actionsPerRun: z.number().positive(),
      actionsPerRunSource: z.enum(["run_class", "caller_supplied"]),
      runClass: z.enum(RUN_CLASSES),
      tier: z.enum(["free", "build", "scale", "enterprise"]),
    }),
    actionsPerYear: z.number().int().nonnegative(),
    /** Included by the tier; null when the tier's figure is negotiated. */
    includedActionsAnnual: z.number().int().nonnegative().nullable(),
    /** Actions past the allowance. */
    overageActions: z.number().int().nonnegative(),
    band: z.object({ id: z.string(), usdPer1000: z.number().nonnegative() }),
    /** Overage cost for the year, in USD. */
    overageUsd: z.number().nonnegative(),
    /**
     * A note stating what this estimate does NOT include — the subscription
     * platform fee, which is negotiated on enterprise, and model tokens, which
     * are the customer's own bill under BYOK.
     */
    excludes: z.string(),
  }),
});

export type BillingActionEstimateInput = z.output<
  typeof billingActionEstimate.input
>;
export type BillingActionEstimateOutput = z.output<
  typeof billingActionEstimate.output
>;
