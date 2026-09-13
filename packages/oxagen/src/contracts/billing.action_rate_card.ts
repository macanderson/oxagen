import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * get_rate_card
 *
 * The published price of a governed action (ADR-052, spec §4): the volume
 * bands, the per-tier included allowances, the evidence-retention price, and
 * the statement that model tokens are reported and billed at zero.
 *
 * Read-only and static — it reads constants, not the organisation's data, so
 * two customers on the same tier see the same answer. That is the point: a
 * price a buyer cannot see before they buy is the thing ADR-052 rejects
 * cost-derived credits for.
 *
 * `noBillingGate: true`. Charging someone to read the rate card would be the
 * same mistake as charging them to read their bill.
 */

const rateBand = z.object({
  /** Stable band identifier, e.g. "1m-5m". */
  id: z.string(),
  /** Inclusive lower bound in annual governed actions. */
  minAnnualActions: z.number().int().nonnegative(),
  /** Exclusive upper bound, or null on the top band. */
  maxAnnualActions: z.number().int().positive().nullable(),
  /** USD per 1,000 governed actions. */
  usdPer1000: z.number().nonnegative(),
});

const tierAllowance = z.object({
  tier: z.enum(["free", "build", "scale", "enterprise"]),
  /**
   * Governed actions included per entitlement year, or null when the figure is
   * negotiated per contract (enterprise). Null means "see your agreement",
   * never "unlimited".
   */
  includedActionsAnnual: z.number().int().nonnegative().nullable(),
  /** Evidence retention included, in months. */
  retentionMonths: z.number().int().positive(),
});

export const billingActionRateCard = registerCapability({
  name: "get_rate_card",
  domain: "billing",
  description:
    "The published rate card for governed actions (ADR-052): volume bands per 1,000 actions, per-tier included allowances, the evidence-retention price beyond the included window, and confirmation that model tokens are reported at zero charge. Static — the same answer for every organisation on a tier.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  // Org-scoped so the answer can carry the caller's own tier alongside the
  // published table, which is the question a buyer actually has.
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
  input: z.object({}),
  output: z.object({
    /** The billable unit, spelled out for a human reading an API response. */
    unit: z.literal("governed_action"),
    /** One sentence a buyer can check against their statements. */
    summary: z.string(),
    bands: z.array(rateBand),
    tiers: z.array(tierAllowance),
    retention: z.object({
      includedMonths: z.number().int().positive(),
      usdPerGbMonth: z.number().nonnegative(),
      /** Extended retention is opt-in and never accrues by default (spec §7.4). */
      optIn: z.literal(true),
    }),
    modelTokens: z.object({
      /** Always zero. The zero is the message, not an omission (spec §4.4). */
      usdPerToken: z.literal(0),
      explanation: z.string(),
    }),
    /** The caller's own tier, so the published table can be read against it. */
    yourTier: z.enum(["free", "build", "scale", "enterprise"]),
    /** The caller's own included allowance, from their plan row. */
    yourIncludedActionsAnnual: z.number().int().nonnegative(),
  }),
});

export type BillingActionRateCardInput = z.output<
  typeof billingActionRateCard.input
>;
export type BillingActionRateCardOutput = z.output<
  typeof billingActionRateCard.output
>;
