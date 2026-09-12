import { z } from "zod";
import { defineTool } from "./_define";
import { spendBudgetSetInputObject } from "../billing.budget.set";
import { billingBudgetGet } from "../billing.budget.get";
import { budgetPolicyWrite } from "../budget.policy.write";
import { budgetPolicyRead } from "../budget.policy.read";
import { workspaceBudgetPolicyRead } from "../workspace.budget_policy.read";

/**
 * Appendix E: `set_budget` — "any level". Absorbs `set_spend_budget`,
 * `get_spend_budget`, `update_user_budget`, `get_user_budget` and
 * `get_budget_policy`.
 *
 * v1 had three unrelated budget systems: an org/workspace period ceiling
 * (`set_spend_budget`), a user's own per-turn ceiling (`update_user_budget`),
 * and a workspace-governed per-turn policy (`get_budget_policy`). §12.5 and A.8
 * `billing.budgets` collapse them into one row: a budget belongs to an
 * organization, workspace, operator or agent, has a period, a limit, and a hard
 * or soft mode. This tool is that row.
 *
 * Three decisions worth checking:
 *
 * 1. **Two things were both called `mode`, and only one keeps the name.** §12.5
 *    gives a budget a `hard` or `soft` mode — hard budgets are enforced at the
 *    model proxy before the call. `update_user_budget`'s mode was a different
 *    axis entirely (grace / prompt / enforce: what happens AT the ceiling). It
 *    carries by import under the name `onBreach`, because leaving both as
 *    `mode` would make one of them silently win in every handler that reads the
 *    input, and a budget that enforces when it meant to prompt is the expensive
 *    direction of that mistake.
 *
 * 2. **`period` gains `turn`.** A.8 lists daily, monthly and rolling.
 *    `update_user_budget`'s ceiling is per-turn, and Appendix E folds it here,
 *    so a fourth literal is added rather than dropping a shipped ceiling. It is
 *    the period for which `onBreach` and `graceOveragePct` are meaningful and
 *    `windowDays` is not.
 *
 * 3. **The reads fold into the write's response.** `get_spend_budget`,
 *    `get_user_budget` and `get_budget_policy` all returned a status; a set
 *    returns every ceiling now governing the scope, so the panel renders the
 *    new state without a second round trip. That is v1 `set_spend_budget`'s
 *    round-trip behaviour, widened to the levels §12.5 adds.
 *
 * Amounts stay plain USD numbers rather than A.8's `limit_micros`, carried from
 * the v1 contracts along with the reason: the handler converts, so the client
 * never juggles bigints. §12.3's integer-micro-USD rule governs cost records
 * and statement lines, not the ceiling a human types.
 */

// Carried by import and widened per §12.5: "Each budget belongs to an
// organization, workspace, operator, or agent."
const budgetScope = z.enum([
  ...spendBudgetSetInputObject.shape.scope.options,
  "operator",
  "agent",
] as const);

// Carried and widened per A.8 `billing.budgets.period` (daily) plus the
// per-turn ceiling absorbed from update_user_budget — see the header.
const budgetPeriod = z.enum([
  ...spendBudgetSetInputObject.shape.period.options,
  "daily",
  "turn",
] as const);

/**
 * §12.5 / A.8 `billing.budgets.mode`. New: no absorbed contract had the field,
 * because v1's org ceiling was always hard and its per-turn ceiling always
 * soft. Making it explicit is what lets one row serve both.
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
   * Carried from update_user_budget's `mode`, renamed — see header. Omit to
   * leave unchanged; it decides what happens AT the ceiling, where `mode`
   * decides whether the ceiling is enforced at all.
   */
  onBreach: budgetPolicyWrite.input.shape.mode,
  /**
   * Carried: the grace cushion, still capped at 10 (1000%) so a fat-fingered
   * value cannot quietly disable the ceiling it modifies.
   */
  graceOveragePct: budgetPolicyWrite.input.shape.graceOveragePct,

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
  // Carried from get_user_budget / get_budget_policy: the two fields those
  // reads returned, now attached to the budget they describe.
  onBreach: budgetPolicyRead.output.shape.mode,
  graceOveragePct: workspaceBudgetPolicyRead.output.shape.graceOveragePct,
  notifyAtPercent: z.array(z.number().int()),
});

export const setBudget = defineTool({
  name: "set_budget",
  domain: "billing",
  description:
    "Set the spend ceiling for any level — organization, workspace, operator, or agent (§12.5). Choose the period (turn, daily, monthly, or a trailing rolling window), the USD limit, whether the ceiling is hard (enforced at the model proxy before the call) or soft, what happens at the ceiling, and the notification thresholds. Returns every ceiling now governing the scope with its live burn.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  // Stricter of the two: set_spend_budget is scoped, update_user_budget was
  // not. A budget that can now name an operator or agent must resolve the
  // workspace it belongs to, or "agent X" is ambiguous across tenants.
  scoped: true,

  absorbs: [
    "set_spend_budget",
    "get_spend_budget",
    "update_user_budget",
    "get_user_budget",
    "get_budget_policy",
  ],
  drops: [
    {
      field: "enforcement",
      from: "get_budget_policy",
      why: "v1 distinguished a workspace budget that SEEDS members (default) from one they cannot exceed (ceiling). §12.5 gives a budget one enforcement axis — hard or soft — and a seeding default is exactly `mode: 'soft'` on the workspace-scope row, so keeping both would be two names for one decision",
    },
  ],

  /**
   * Strictest of the five. `set_spend_budget` is sensitivity medium / risk
   * medium and grants only governance roles; `update_user_budget` was low / low
   * and granted every role down to Viewer, because in v1 it could only change
   * the caller's own per-turn ceiling. That is no longer true: this tool can
   * raise an org ceiling, which §12.5 makes the override that clears a denial
   * at the proxy. The strict source wins on every field — including at
   * workspace scope, where set_spend_budget's grant is the ceiling and Member
   * and Viewer, which update_user_budget granted, do not carry.
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
  // Writes billing.budgets. Both write sources mutate — budget.policy.write's
  // handler is an insert-or-update on the preferences row.
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
     * Every ceiling now governing the scope. A per-turn ceiling under an
     * operator budget under an org ceiling is the normal case, and the panel
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
