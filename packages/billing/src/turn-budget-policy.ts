import { z } from "zod";
import {
  TURN_BUDGET_MODE_VALUES,
  type TurnBudgetMode,
  type TurnBudgetPolicy,
  type GovernedBudget,
} from "./turn-budget";

/**
 * turn-budget-policy.ts — pure per-turn budget resolution shared by every chat
 * surface (the app chat route, the REST API chat route, MCP). Both the
 * wire-shape validation (the zod schema) and the policy-precedence logic
 * (per-turn request override wins; omitting it falls back to the user's saved
 * default; workspace governance merges on top) live HERE so the surfaces can't
 * drift — a budget resolved on one surface is resolved identically on all of
 * them.
 */

/**
 * BodySchema's `budget` field — a per-turn override the client may send with
 * the request. `null`/omitted means "no override for this turn", NOT "budget
 * off" (an explicit `{ enabled: false, ... }` means off). Nonsense is
 * rejected: `limitUsd` must be a positive number whenever `enabled` is true.
 */
export const requestTurnBudgetSchema = z
  .object({
    enabled: z.boolean(),
    limitUsd: z.number().positive().nullable(),
    mode: z.enum(TURN_BUDGET_MODE_VALUES),
    graceOveragePct: z.number().min(0).max(10),
  })
  .refine((v) => !v.enabled || (v.limitUsd !== null && v.limitUsd > 0), {
    message:
      "budget.limitUsd must be a positive number when budget.enabled is true",
    path: ["limitUsd"],
  });

export type RequestTurnBudget = z.output<typeof requestTurnBudgetSchema>;

/** The budget.policy.read handler's output shape (mirrors
 * BudgetPolicyReadOutput without importing the contract layer here). */
export interface SavedBudgetPolicy {
  enabled: boolean;
  limitUsd: number | null;
  mode: TurnBudgetMode;
  graceOveragePct: number;
}

/** Convert a budget.policy.read output (limitUsd: number|null) to the engine's
 * TurnBudgetPolicy shape (limitUsd: number, 0 meaning "no limit set"). */
export function turnBudgetPolicyFromSaved(
  saved: SavedBudgetPolicy,
): TurnBudgetPolicy {
  return {
    enabled: saved.enabled,
    limitUsd: saved.limitUsd ?? 0,
    mode: saved.mode,
    graceOveragePct: saved.graceOveragePct,
  };
}

/**
 * Resolve the effective per-turn budget policy for a turn: an explicit
 * per-turn `requestBudget` (sent by the composer's BudgetControl, or a direct
 * API/MCP/CLI caller) always wins over the user's saved default. Omitting it
 * (`null` — the client sent no `budget` field, or it failed to parse) falls
 * back to `savedDefault`, which the caller resolves via budget.policy.read
 * (or TURN_BUDGET_OFF on any read failure — never let a broken preferences
 * row block a turn from running).
 */
export function resolveTurnBudgetPolicy(
  requestBudget: RequestTurnBudget | null,
  savedDefault: TurnBudgetPolicy,
): TurnBudgetPolicy {
  if (!requestBudget) return savedDefault;
  return {
    enabled: requestBudget.enabled,
    // A disabled request budget carries limitUsd=null by convention (see
    // requestTurnBudgetSchema); normalize to 0 either way so a disabled policy
    // never accidentally gates a turn on a stale limit value.
    limitUsd: requestBudget.enabled ? (requestBudget.limitUsd ?? 0) : 0,
    mode: requestBudget.mode,
    graceOveragePct: requestBudget.graceOveragePct,
  };
}

// ── Workspace governance ─────────────────────────────────────────────
// A workspace can impose a governed budget on top of the member's own policy
// (resolveEffectiveTurnBudget in ./turn-budget does the actual pure merge —
// this section only adapts workspace.budget.policy.read's wire shape into the
// GovernedBudget input that merge expects).

/** The workspace.budget.policy.read handler's output shape (mirrors
 * WorkspaceBudgetPolicyReadOutput without importing the contract layer here,
 * same rationale as SavedBudgetPolicy above — this module stays unit-testable
 * without pulling in the contract/registry layer). */
export interface SavedWorkspaceGovernance {
  enabled: boolean;
  limitUsd: number | null;
  mode: TurnBudgetMode;
  graceOveragePct: number;
  enforcement: "default" | "ceiling";
}

/**
 * Convert a workspace.budget.policy.read output into the `GovernedBudget`
 * shape `resolveEffectiveTurnBudget` (from ./turn-budget) expects for its
 * `workspace` argument. Returns `null` when the workspace has no governance
 * active (`enabled: false`) so the merge is a documented no-op rather than an
 * accidental $0 ceiling — mirrors `applyCeiling`'s own "no positive limit ⇒ no
 * ceiling" guard in ./turn-budget.
 *
 * The CALLER must also fail-open to `null` on any read/parse error (an
 * unregistered handler, a down DB, or a denied IAM check must never block a
 * turn) — see each chat route's `.catch(() => null)` around the
 * `workspace.budget.policy.read` invoke() call.
 */
export function governedBudgetFromRead(
  read: SavedWorkspaceGovernance,
): GovernedBudget | null {
  if (!read.enabled) return null;
  return {
    policy: {
      enabled: true,
      limitUsd: read.limitUsd ?? 0,
      mode: read.mode,
      graceOveragePct: read.graceOveragePct,
    },
    enforcement: read.enforcement,
  };
}
