import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * get_evidence_retention
 *
 * The second meter (ADR-052 §4.3): how long this organisation's evidence is
 * held, whether it has opted into paying for anything beyond the included
 * twelve months, and what that costs.
 *
 * Evidence is the asset and holding it is the only cost of Oxagen's that
 * compounds — it grows with time held, not with tokens spent. Under spec §7.4
 * extended retention is OPT-IN, so this capability's most important field is
 * the one that says whether it is on: silently accruing storage charges on
 * evidence a customer forgot they were keeping is the surprise the whole
 * pricing model exists to avoid, and the way to avoid it is to make the state
 * visible before the bill arrives.
 *
 * `noBillingGate: true` — reading your own retention posture is never a charge.
 */

export const billingEvidenceRetention = registerCapability({
  name: "get_evidence_retention",
  domain: "billing",
  description:
    "Evidence-retention posture and its price (ADR-052 §4.3): the included window, the organisation's effective retention window from its pinned retention policy, whether it has opted into paying for retention beyond the included months, the per-GB-month rate, and retention credits charged so far. Extended retention never accrues without an explicit opt-in.",
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
  input: z.object({}),
  output: z.object({
    /** Months of evidence retention included on every paid tier. */
    includedMonths: z.number().int().positive(),
    /**
     * The longest retention window any of this organisation's pinned retention
     * policies declares, in days, or null when none is pinned yet. Null means
     * the organisation has not declared one, not that evidence is kept forever.
     */
    effectiveRetentionDays: z.number().int().positive().nullable(),
    /**
     * Whether this organisation pays for retention beyond the included window.
     * False is the default and means nothing accrues (spec §7.4).
     */
    extendedRetentionEnabled: z.boolean(),
    usdPerGbMonth: z.number().nonnegative(),
    /**
     * Evidence volume held beyond the included window, in GB.
     *
     * Null when it has not been measured — see `storedGbMeasured`. A null here
     * is the honest answer; a zero would read as "you are storing nothing",
     * which is a different and possibly false claim.
     */
    storedGbBeyondIncluded: z.number().nonnegative().nullable(),
    /**
     * Whether `storedGbBeyondIncluded` is a measurement or an absence. False
     * means the accounting job has not run for this organisation yet.
     */
    storedGbMeasured: z.boolean(),
    /** Retention credits charged to this organisation in the current period. */
    creditsChargedThisPeriod: z.number().int().nonnegative(),
  }),
});

export type BillingEvidenceRetentionInput = z.output<
  typeof billingEvidenceRetention.input
>;
export type BillingEvidenceRetentionOutput = z.output<
  typeof billingEvidenceRetention.output
>;
