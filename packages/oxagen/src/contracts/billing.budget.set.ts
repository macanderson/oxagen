import { z } from "zod";
import { registerCapability } from "../registry";

// Mirrors SpendBudgetPeriod / SpendBudgetScope in @oxagen/billing (literal to
// keep the contract layer dependency-light). The values are a locked API surface.
const spendPeriod = z.enum(["monthly", "rolling"]);
const spendScope = z.enum(["org", "workspace"]);
const spendState = z.enum([
  "ok",
  "threshold_50",
  "threshold_80",
  "threshold_95",
  "exceeded",
]);

// The saved ceiling with its live burn (same shape get_spend_budget returns per
// scope) so a set round-trips the new state the panel should render immediately.
const spendBudgetStatus = z.object({
  scope: spendScope,
  publicId: z.string().nullable(),
  enabled: z.boolean(),
  period: spendPeriod,
  windowDays: z.number().int().positive().nullable(),
  limitUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  projectedUsd: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
  state: spendState,
  reachedThreshold: z.number().int().nonnegative(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

// The base object (before the cross-field refine) so surfaces that need the
// field shape — the MCP tool's xmcp schema — can read `.shape`; a refined
// ZodEffects has none. The kernel still parses the full refined `input` on every
// invoke(), so the rolling/monthly window rule is enforced regardless of surface.
export const spendBudgetSetInputObject = z.object({
  /** Which ceiling to set: "org" (all workspaces) or "workspace" (active workspace). */
  scope: spendScope,
  /** Whether the ceiling is enforced. false = keep the config but stop gating. */
  enabled: z.boolean(),
  /** Window the ceiling is measured over. */
  period: spendPeriod,
  /** Required for "rolling" (trailing N days, > 0); must be omitted/null for "monthly". */
  windowDays: z.number().int().positive().nullable().optional(),
  /** The hard ceiling in USD (> 0). */
  limitUsd: z.number().positive(),
});

// Mirror the DB CHECK: a rolling budget carries a positive window; a monthly one must not.
const spendBudgetSetInput = spendBudgetSetInputObject.refine(
  (v) =>
    v.period === "rolling"
      ? v.windowDays != null && v.windowDays > 0
      : v.windowDays == null,
  {
    message:
      "windowDays is required (and > 0) for period 'rolling', and must be omitted for 'monthly'",
    path: ["windowDays"],
  },
);

export const billingBudgetSet = registerCapability({
  name: "set_spend_budget",
  domain: "billing",
  description:
    "Set (create or replace) the hard period-to-date spend ceiling for one scope — the org-level ceiling that covers every workspace, or this workspace's own ceiling. Choose the window (monthly = calendar month to date; rolling = a trailing N-day window), the USD limit, and whether it is enforced. Over-ceiling agent runs are denied at invoke() before any provider call; RAISING a ceiling here is the org-admin override that clears a denial (IAM-gated and audited). Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // Writing your own budget must never be blocked by being over it.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: spendBudgetSetInput,
  output: spendBudgetStatus,
});

export type BillingBudgetSetInput = z.output<typeof billingBudgetSet.input>;
export type BillingBudgetSetOutput = z.output<typeof billingBudgetSet.output>;
