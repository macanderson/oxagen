import { z } from "zod";
import { registerCapability } from "../registry";
import { moneySchema } from "../money";

// The window a ceiling is measured over. Mirrors SpendBudgetPeriod in
// @oxagen/billing (kept as a literal here to keep the contract layer
// dependency-light — the values are a locked API surface).
export const spendPeriod = z.enum(["monthly", "rolling"]);
export const spendScope = z.enum(["org", "workspace"]);
export const spendState = z.enum([
  "ok",
  "threshold_50",
  "threshold_80",
  "threshold_95",
  "exceeded",
]);

// One configured ceiling with its LIVE burn, the shape a Budgets panel renders
// per scope. Money is micro-units in a decimal string with its currency
// (ADR-057 decision 2, apps/app/ARCHITECTURE.md INV-09): the store keeps
// `limit_micros bigint`, ClickHouse keeps `cost_usd_micros`, and neither is
// rounded through a float on the way out.
export const spendBudgetStatus = z.object({
  /** "org" (all workspaces roll up) or "workspace" (this workspace only). */
  scope: spendScope,
  /** External handle for the ceiling row; null when no ceiling is configured yet. */
  publicId: z.string().nullable(),
  /** Whether the ceiling is enforced. A disabled ceiling is a documented no-op. */
  enabled: z.boolean(),
  period: spendPeriod,
  /** Trailing window length in days for `rolling`; null for `monthly`. */
  windowDays: z.number().int().positive().nullable(),
  /** The hard ceiling; null when no ceiling is configured. */
  limit: moneySchema.nullable(),
  /** Period-to-date spend. */
  spent: moneySchema,
  /** Linear projection of spend to the period end (monthly); equals spent for rolling. */
  projected: moneySchema,
  /** spent ÷ limit (0 when no limit). */
  ratio: z.number().nonnegative(),
  /** Position of spend relative to the ceiling. */
  state: spendState,
  /** Highest ladder rung reached (0/50/80/95/100). */
  reachedThreshold: z.number().int().nonnegative(),
  /** Inclusive window start (ISO 8601). */
  windowStart: z.string(),
  /** Exclusive window end / "now" (ISO 8601). */
  windowEnd: z.string(),
});

export const billingBudgetGet = registerCapability({
  name: "get_spend_budget",
  domain: "billing",
  description:
    "Read the hard period-to-date spend ceilings governing the active scope — the org-level ceiling (covers every workspace) and this workspace's own ceiling, if configured — each with its live burn in micro-units: period-to-date spend, projection to the period end, the percent-of-ceiling reached, and whether the gate is currently denying. Reading your own budget is never blocked by being over it.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // Reading your own spend/budget must never be denied by the budget gate.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    /** One entry per configured ceiling in the active scope (org first, then workspace). */
    budgets: z.array(spendBudgetStatus),
  }),
});

export type BillingBudgetGetOutput = z.output<typeof billingBudgetGet.output>;
export type SpendBudgetStatusDto = z.output<typeof spendBudgetStatus>;
