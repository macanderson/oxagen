import { z } from "zod";
import { registerCapability } from "../registry";
import { moneySchema } from "./spend.shared";
import {
  spendBudgetStatus,
  spendPeriod,
  spendScope,
} from "./billing.budget.get";

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
  /**
   * The hard ceiling in micro-units (> 0). The store records the ceiling in
   * micro-USD (`billing.spend_budgets.limit_micros`), so `currency` is `USD`.
   */
  limit: moneySchema,
});

// Mirror the DB CHECK: a rolling budget carries a positive window; a monthly
// one must not. A ceiling is positive and in the store's currency.
const spendBudgetSetInput = spendBudgetSetInputObject
  .refine(
    (v) =>
      v.period === "rolling"
        ? v.windowDays != null && v.windowDays > 0
        : v.windowDays == null,
    {
      message:
        "windowDays is required (and > 0) for period 'rolling', and must be omitted for 'monthly'",
      path: ["windowDays"],
    },
  )
  .refine((v) => v.limit.currency === "USD", {
    message:
      "limit.currency must be USD: the store records ceilings in micro-USD",
    path: ["limit", "currency"],
  })
  .refine((v) => /^[1-9]\d*$/.test(v.limit.micros), {
    message: "limit.micros must be a positive integer",
    path: ["limit", "micros"],
  });

export const billingBudgetSet = registerCapability({
  name: "set_spend_budget",
  domain: "billing",
  description:
    "Set (create or replace) the hard period-to-date spend ceiling for one scope — the org-level ceiling that covers every workspace, or this workspace's own ceiling. Choose the window (monthly = calendar month to date; rolling = a trailing N-day window), the limit in micro-units, and whether it is enforced. Over-ceiling agent runs are denied at invoke() before any provider call; RAISING a ceiling here is the org-admin override that clears a denial (IAM-gated and audited). Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // Writing your own budget must never be blocked by being over it.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "billing" },
  sensitivity: "medium",
  mutates: true,
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
