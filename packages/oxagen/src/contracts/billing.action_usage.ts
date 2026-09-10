import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * get_action_usage
 *
 * What the organisation has spent its governance budget on this entitlement
 * year: actions taken, actions the allowance absorbed, actions charged as
 * overage, the band they priced at, and the model spend that was reported at
 * zero beside them.
 *
 * This is the page a customer opens to answer "why is my bill this number".
 * ADR-052 exists because the previous meter could not answer that question, so
 * the capability that answers it is part of shipping the meter, not a follow-up.
 *
 * Read-only, `noBillingGate: true` — an organisation that has run out of credits
 * must still be able to see that it has run out.
 */

const capabilityRow = z.object({
  /** Canonical capability name. */
  capability: z.string(),
  actions: z.number().int().nonnegative(),
});

export const billingActionUsage = registerCapability({
  name: "get_action_usage",
  domain: "billing",
  description:
    "Governed-action usage for the organisation's current entitlement year: actions taken, actions covered by the plan allowance, actions charged as overage, the volume band in force, credits charged, and the model spend reported at zero beside them. The answer to 'why is my bill this number'.",
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
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({
    /**
     * Include the per-capability breakdown. Off by default: it is a ClickHouse
     * scan, and the headline numbers come from one indexed Postgres row.
     */
    includeBreakdown: z.boolean().optional().default(false),
  }),
  output: z.object({
    period: z.object({
      /** First instant of the entitlement year, ISO-8601. */
      start: z.string(),
      /** First instant of the next one, ISO-8601. */
      end: z.string(),
    }),
    /** Governed actions taken in the period, allowance-covered ones included. */
    actionsUsed: z.number().int().nonnegative(),
    /** Included in the plan and therefore free. */
    actionsIncluded: z.number().int().nonnegative(),
    /** Of those taken, how many the allowance absorbed. */
    actionsWithinAllowance: z.number().int().nonnegative(),
    /** Of those taken, how many priced as overage. */
    actionsCharged: z.number().int().nonnegative(),
    /** Actions left before overage begins; zero once the allowance is spent. */
    actionsRemaining: z.number().int().nonnegative(),
    band: z.object({
      id: z.string(),
      usdPer1000: z.number().nonnegative(),
    }),
    /**
     * Credits charged for overage so far, at the band in force when each
     * action landed.
     */
    creditsCharged: z.number().int().nonnegative(),
    /**
     * What the whole period's overage would cost priced at the single band the
     * year-end total lands in — the §4.1 rule as written.
     *
     * The recorder charges incrementally at the running band, which for a
     * customer who crossed a band boundary mid-year is a larger number than
     * this. The difference is a true-up owed to the customer, and it is
     * reported rather than absorbed: a discrepancy a customer discovers is
     * worth more than the amount.
     */
    creditsAtFinalBand: z.number().int().nonnegative(),
    /** creditsCharged − creditsAtFinalBand. Zero or positive. */
    bandTrueUpCredits: z.number().int().nonnegative(),
    /** Whether the meter is charging or only counting (spec §7.5). */
    meterMode: z.enum(["shadow", "charge"]),
    modelSpend: z.object({
      /**
       * Provider token cost over the period in micro-USD — reported in full
       * (spec §4.4).
       */
      reportedCostMicros: z.number().int().nonnegative(),
      /**
       * Always zero for tokens the customer's own key paid for. The line
       * exists rather than being omitted; the zero is the message.
       */
      chargedCredits: z.number().int().nonnegative(),
      /**
       * ADR-053 §3: tokens the PLATFORM key paid for are the one exception and
       * are billed back. Zero for an organisation on its own key.
       */
      assistantTokenCredits: z.number().int().nonnegative(),
    }),
    /** Present only when `includeBreakdown` was set. */
    byCapability: z.array(capabilityRow),
  }),
});

export type BillingActionUsageInput = z.output<typeof billingActionUsage.input>;
export type BillingActionUsageOutput = z.output<
  typeof billingActionUsage.output
>;
