import { z } from "zod";
import { defineTool } from "./_define";
import { spendBudgetSetInputObject } from "../billing.budget.set";
import { billingBudgetGet } from "../billing.budget.get";

/**
 * Appendix E: `set_budget` — "any level". Absorbs `set_spend_budget` and
 * `get_spend_budget`.
 *
 * §12.5 and A.8 `billing.budgets` give a budget one row: a budget belongs to an
 * organization, workspace, operator or agent, has a period, a limit, and a hard
 * or soft mode. This tool is that row.
 *
 * Appendix E also folded in three per-turn sources: `update_user_budget`,
 * `get_user_budget` and `get_budget_policy`. They set a budget for one turn of
 * Oxagen's in-app assistant. Mac ruled on 2026-10-02 that no customer sets a
 * budget for the assistant (ADR-235), and ADR-277 deleted all three. So this
 * tool carries no `turn` period, and none of the fields that only meant
 * something for a turn: what happens at the ceiling (`grace`, `prompt` or
 * `enforce`) and the grace cushion. Appendix E in oxageninc/roadmap still
 * lists the three, and the fixtures here no longer do.
 *
 * Two decisions worth checking:
 *
 * 1. **`mode` is hard or soft.** §12.5 gives a budget a `hard` or `soft` mode.
 *    Hard budgets are enforced at the model proxy before the call.
 *
 * 2. **The read folds into the write's response.** `get_spend_budget` returned
 *    a status; a set returns every ceiling now governing the scope, so the
 *    panel renders the new state without a second round trip. That is v1
 *    `set_spend_budget`'s round-trip behaviour, widened to the levels §12.5
 *    adds.
 *
 * Amounts are `Money` — integer micro-units in a decimal string with their
 * currency — carried from `set_spend_budget`, which moved to that shape with
 * the rest of the billing contracts (ADR-057 decision 2). A ceiling is A.8's
 * `limit_micros` on the way in as well as on the way out, so §12.3's
 * integer-micro rule now governs the ceiling a human types the same way it
 * governs the cost records it is compared against, and no float sits between
 * the two.
 */

// Carried by import and widened per §12.5: "Each budget belongs to an
// organization, workspace, operator, or agent."
const budgetScope = z.enum([
  ...spendBudgetSetInputObject.shape.scope.options,
  "operator",
  "agent",
] as const);

// Carried and widened per A.8 `billing.budgets.period` (daily).
const budgetPeriod = z.enum([
  ...spendBudgetSetInputObject.shape.period.options,
  "daily",
] as const);

/**
 * §12.5 / A.8 `billing.budgets.mode`. New: no absorbed contract had the field,
 * because v1's spend ceiling was always hard. Making it explicit lets one row
 * hold a hard ceiling or a soft one that only notifies.
 */
const budgetMode = z.enum(["hard", "soft"]);

/**
 * The base object before the cross-field refines, exported for the same reason
 * `spendBudgetSetInputObject` is: a refined input is a ZodEffects with no
 * `.shape`, and surfaces need the field map to build their own arg lists. The
 * kernel still parses the refined `input` on every invoke, so the rules below
 * hold on every surface regardless.
 */
export const setBudgetInputObject = spendBudgetSetInputObject.extend({
  // Carried, widened — see header.
  scope: budgetScope,
  period: budgetPeriod,

  /**
   * New. The operator or agent principal id the budget belongs to (A.8
   * `scope_id`). Omitted for org, and for workspace when the request's own
   * scope already names it.
   */
  scopeId: z.string().optional(),

  // New, §12.5: hard budgets are enforced at the model proxy before the call
  // and in the policy bundle for harness-tier runs; soft ones only notify.
  mode: budgetMode.default("hard"),

  /**
   * A.8 `notify_at`: the percentages that raise a notification. New as an
   * input — v1 hard-coded the 50/80/95 ladder and only reported which rung had
   * been reached.
   */
  notifyAtPercent: z.array(z.number().int().min(1).max(100)).max(10).optional(),
});

/**
 * One budget with its live burn. The whole v1 status carries by reference —
 * spent, projected, ratio, state, the threshold ladder and the window bounds,
 * each with the docs that say what it means — widened to the level and the two
 * enforcement axes it now describes.
 */
const budgetStatus = billingBudgetGet.output.shape.budgets.element.extend({
  scope: budgetScope,
  scopeId: z.string().nullable(),
  period: budgetPeriod,
  mode: budgetMode,
  notifyAtPercent: z.array(z.number().int()),
});

export const setBudget = defineTool({
  name: "set_budget",
  domain: "billing",
  description:
    "Set the spend ceiling for any level — organization, workspace, operator, or agent (§12.5). Choose the period (daily, monthly, or a trailing rolling window), the USD limit, whether the ceiling is hard (enforced at the model proxy before the call) or soft, and the notification thresholds. Returns every ceiling now governing the scope with its live burn.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  // Carried from set_spend_budget. A budget that can now name an operator or
  // agent must resolve the workspace it belongs to, or "agent X" is ambiguous
  // across tenants.
  scoped: true,

  absorbs: ["set_spend_budget", "get_spend_budget"],
  drops: [],

  /**
   * Carried from `set_spend_budget`: sensitivity medium, risk medium, and only
   * governance roles. This tool can raise an org ceiling, which §12.5 makes
   * the override that clears a denial at the proxy. At workspace scope it
   * grants Owner alone, because workspace Admin is not a system workspace role.
   */
  agent: { requiresApproval: false, riskLevel: "medium", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: { Owner: "allow" },
  },
  /**
   * Carried from set_spend_budget: writing a budget must never be blocked by
   * being over one, or an org that breached its ceiling could not raise it.
   */
  noBillingGate: true,
  // Writes billing.budgets.
  mutates: true,

  input: setBudgetInputObject
    // Carried verbatim from set_spend_budget so the client-facing error does
    // not change; the rule mirrors the DB CHECK on billing.budgets.
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
    // New, and the reason the scope enum widened: an operator or agent budget
    // that does not say which one is not a budget.
    .refine(
      (v) =>
        v.scope === "org" ||
        v.scope === "workspace" ||
        (v.scopeId != null && v.scopeId.length > 0),
      {
        message: "scopeId is required for scope 'operator' and 'agent'",
        path: ["scopeId"],
      },
    ),

  output: z.object({
    /**
     * Every ceiling now governing the scope. An operator budget under a
     * workspace ceiling under an org ceiling is the normal case, and the panel
     * has to show which one bites first.
     */
    budgets: z.array(budgetStatus),
    /**
     * Carried from set_spend_budget's round-trip contract: the ceiling this
     * call wrote, so a caller that set one budget among several does not have
     * to find it again in the list.
     */
    written: budgetStatus,
  }),
});

export type SetBudgetInput = z.output<typeof setBudget.input>;
export type SetBudgetOutput = z.output<typeof setBudget.output>;
