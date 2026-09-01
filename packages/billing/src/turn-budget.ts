import { providerCostUsd, type RateCard } from "./pricing";

/**
 * Per-turn dollar budget — the metered ceiling a user can put on a single agent
 * turn. This module is the SINGLE SOURCE OF TRUTH for the budget's shape, its
 * three enforcement modes, and the pure evaluator every surface (CLI, API, app)
 * runs, so a budget behaves identically everywhere it is configured.
 *
 * A turn budget is OFF by default. When enabled it carries a dollar `limitUsd`
 * and one `mode` that decides what happens the moment the turn's cumulative
 * provider cost reaches that limit. The host builds the guard and hands it to
 * the engine as `RunCodingAgentOptions.budgetGuard`; it converts tokens to
 * dollars via {@link providerCostUsd} and applies the policy below.
 */

/** What happens when a turn's cost reaches the budget limit. Strictness ladder: soft → gated → hard. */
export type TurnBudgetMode = "grace" | "prompt" | "enforce";

export interface TurnBudgetModeMeta {
  mode: TurnBudgetMode;
  /** Concise UI label (segmented control / flag help / slash output). */
  label: string;
  /** One line: exactly what happens at the ceiling. Never ambiguous. */
  description: string;
  /**
   * Case-insensitive synonyms accepted from a human (CLI flag, slash arg) and
   * resolved to the canonical mode by {@link parseTurnBudgetMode}.
   */
  aliases: string[];
}

/**
 * The three enforcement modes, ordered soft → gated → hard. This table is the
 * ONLY place mode labels/copy live; the CLI flag help, the app segmented
 * control, and the docs all read from here so language never drifts.
 */
export const TURN_BUDGET_MODES: Record<TurnBudgetMode, TurnBudgetModeMeta> = {
  grace: {
    mode: "grace",
    label: "Allow overage (grace window)",
    description:
      "Soft cap — keep going past the limit up to a grace cushion, then stop automatically.",
    aliases: ["grace", "soft", "overage", "allow", "flex"],
  },
  prompt: {
    mode: "prompt",
    label: "Ask to continue",
    description:
      "Gated cap — pause at the limit and ask for approval before spending more.",
    aliases: ["prompt", "ask", "approve", "approval", "confirm"],
  },
  enforce: {
    mode: "enforce",
    label: "Hard stop",
    description:
      "Hard cap — halt the turn the instant the limit is crossed and fail with a budget-exceeded reason.",
    aliases: ["enforce", "hard", "stop", "strict", "fail", "block"],
  },
};

/** Canonical mode values, in strictness order — for zod enums and UI iteration. */
export const TURN_BUDGET_MODE_VALUES = ["grace", "prompt", "enforce"] as const;

/** Default grace cushion (fraction ABOVE the limit) for `grace` mode: 25%. */
export const DEFAULT_GRACE_OVERAGE_PCT = 0.25;

/** The default enforcement mode when a user turns a budget on without naming one. */
export const DEFAULT_TURN_BUDGET_MODE: TurnBudgetMode = "prompt";

export interface TurnBudgetPolicy {
  /** When false, no ceiling is enforced — the turn runs unbounded. This is the default. */
  enabled: boolean;
  /** Per-turn ceiling in USD. Must be > 0 when `enabled`; ignored when disabled. */
  limitUsd: number;
  /** What to do at the ceiling. */
  mode: TurnBudgetMode;
  /**
   * `grace` mode only: the fraction ABOVE `limitUsd` the turn may spend before it
   * hard-stops (0.25 ⇒ allow up to 25% overage). Ignored by `prompt`/`enforce`.
   */
  graceOveragePct: number;
}

/** The off state — no budget. Every surface defaults to this. */
export const TURN_BUDGET_OFF: TurnBudgetPolicy = {
  enabled: false,
  limitUsd: 0,
  mode: DEFAULT_TURN_BUDGET_MODE,
  graceOveragePct: DEFAULT_GRACE_OVERAGE_PCT,
};

/**
 * Resolve a human-typed mode (canonical value, alias, case-insensitive) to a
 * mode, or null when it matches nothing. Powers the CLI `--budget-mode` flag and
 * the `/budget` slash argument.
 */
export function parseTurnBudgetMode(raw: string): TurnBudgetMode | null {
  const norm = raw.trim().toLowerCase();
  if (!norm) return null;
  for (const meta of Object.values(TURN_BUDGET_MODES)) {
    if (meta.mode === norm || meta.aliases.includes(norm)) return meta.mode;
  }
  return null;
}

/** Position of a turn's cost relative to its budget. */
export type TurnBudgetState =
  /** Under the limit — keep going. */
  | "ok"
  /** Over the limit but within the grace cushion (grace mode only) — keep going. */
  | "within_grace"
  /** At/over the limit; the mode gates it (prompt → pause, enforce → stop). */
  | "at_limit"
  /** Past the hard ceiling (enforce limit, or grace cushion exhausted) — stop. */
  | "exceeded";

/** What the caller must do about the current cost. */
export type TurnBudgetAction =
  /** Run the next step. */
  | "continue"
  /** Block for approval before spending more (prompt mode); approve ⇒ raise the ceiling. */
  | "pause"
  /** End the turn now. */
  | "stop";

export interface TurnBudgetVerdict {
  state: TurnBudgetState;
  action: TurnBudgetAction;
  /** Cumulative turn cost in USD at evaluation time. */
  costUsd: number;
  /** The configured base limit in USD. */
  limitUsd: number;
  /** The effective hard ceiling: grace mode ⇒ limit × (1 + grace); else = limit. */
  ceilingUsd: number;
  mode: TurnBudgetMode;
}

/**
 * Evaluate a turn budget against the cost spent so far. PURE — no I/O, no
 * clock — so the identical decision runs on every surface. The caller acts on
 * `action`:
 *   - "continue" → run the next step.
 *   - "pause"    → block for approval (prompt mode); on approve, treat the
 *                  approved amount as the new ceiling and continue.
 *   - "stop"     → end the turn now (enforce breach, or grace cushion exhausted).
 */
export function evaluateTurnBudget(
  policy: TurnBudgetPolicy,
  costUsd: number,
): TurnBudgetVerdict {
  // Disabled or nonsensical limit ⇒ unbounded. Never gate a turn we can't price.
  if (!policy.enabled || policy.limitUsd <= 0) {
    return {
      state: "ok",
      action: "continue",
      costUsd,
      limitUsd: policy.limitUsd,
      ceilingUsd: Number.POSITIVE_INFINITY,
      mode: policy.mode,
    };
  }

  const { limitUsd } = policy;
  const underLimit = costUsd < limitUsd;

  switch (policy.mode) {
    case "enforce":
      return {
        state: underLimit ? "ok" : "exceeded",
        action: underLimit ? "continue" : "stop",
        costUsd,
        limitUsd,
        ceilingUsd: limitUsd,
        mode: "enforce",
      };

    case "prompt":
      return {
        state: underLimit ? "ok" : "at_limit",
        action: underLimit ? "continue" : "pause",
        costUsd,
        limitUsd,
        ceilingUsd: limitUsd,
        mode: "prompt",
      };

    case "grace": {
      const ceilingUsd = limitUsd * (1 + Math.max(0, policy.graceOveragePct));
      if (costUsd < limitUsd)
        return {
          state: "ok",
          action: "continue",
          costUsd,
          limitUsd,
          ceilingUsd,
          mode: "grace",
        };
      if (costUsd < ceilingUsd)
        return {
          state: "within_grace",
          action: "continue",
          costUsd,
          limitUsd,
          ceilingUsd,
          mode: "grace",
        };
      return {
        state: "exceeded",
        action: "stop",
        costUsd,
        limitUsd,
        ceilingUsd,
        mode: "grace",
      };
    }
  }
}

/** Shape of the engine's cumulative usage accumulator (a subset of RunCodingAgentResult["usage"]). */
export interface TurnUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

/**
 * Cumulative turn cost in USD from an engine usage accumulator + the model that
 * produced it. Thin adapter over {@link providerCostUsd} so callers wiring the
 * engine guard don't re-derive the input shape.
 */
export function turnCostUsd(
  model: string,
  usage: TurnUsageSnapshot,
  rateCard?: RateCard,
): number {
  return providerCostUsd(
    {
      model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.cachedInputTokens ?? 0,
    },
    rateCard,
  );
}

/** Surface-supplied reactions the shared guard invokes when a turn hits its budget. */
export interface TurnBudgetGuardHooks {
  /**
   * "prompt" mode only: the turn reached the limit and needs approval to spend
   * more. Resolve `true` to grant ANOTHER budget window (the ceiling is raised
   * by the original limit so the turn doesn't immediately re-pause), or `false`
   * to stop. The CLI shows a TUI confirm here; the app emits an approval card
   * and blocks on the existing approval resolve path.
   */
  onPause?: (verdict: TurnBudgetVerdict) => Promise<boolean> | boolean;
  /** Invoked just before the guard returns "stop" (any mode) — surface the reason to the user. */
  onStop?: (verdict: TurnBudgetVerdict) => void;
  /** "grace" mode: invoked each step the turn runs PAST the limit but within the cushion. */
  onWithinGrace?: (verdict: TurnBudgetVerdict) => void;
  /**
   * Invoked on EVERY evaluation with the cumulative turn cost so far and the
   * current (possibly raised) ceiling — powers live "≈ $0.31" cost estimates
   * while a budgeted turn streams. Fires before the mode ladder, including on
   * steps that continue untouched.
   */
  onTick?: (costUsd: number, limitUsd: number) => void;
}

/**
 * Build the engine's per-turn budget guard from a policy + the model producing
 * the turn. Returns a function shaped for `RunCodingAgentOptions.budgetGuard`
 * (usage → "continue" | "stop"), or `undefined` when the budget is off (so the
 * caller passes no guard and the engine runs unbounded).
 *
 * This is the SINGLE enforcement implementation every surface shares: the CLI,
 * the app chat route, and any future runner wire the SAME guard and differ only
 * in the {@link TurnBudgetGuardHooks} they supply. The guard is resilient —
 * `onPause` rejecting or `hooks` throwing must never wedge a turn, so callers
 * should keep hooks side-effect-only; a throw here would be misclassified by the
 * engine as a model error.
 */
export function createTurnBudgetGuard(
  policy: TurnBudgetPolicy,
  model: string,
  hooks: TurnBudgetGuardHooks = {},
  rateCard?: RateCard,
): ((usage: TurnUsageSnapshot) => Promise<"continue" | "stop">) | undefined {
  if (!policy.enabled || policy.limitUsd <= 0) return undefined;

  // Mutable ceiling: a "prompt"-mode approval extends it by another full window
  // so an approved turn keeps going until it spends the granted amount again.
  let limitUsd = policy.limitUsd;

  return async (usage: TurnUsageSnapshot) => {
    const cost = turnCostUsd(model, usage, rateCard);
    hooks.onTick?.(cost, limitUsd);
    const verdict = evaluateTurnBudget({ ...policy, limitUsd }, cost);
    switch (verdict.action) {
      case "continue":
        if (verdict.state === "within_grace") hooks.onWithinGrace?.(verdict);
        return "continue";
      case "pause": {
        const approved = (await hooks.onPause?.(verdict)) ?? false;
        if (approved) {
          limitUsd = cost + policy.limitUsd; // grant another window from here
          return "continue";
        }
        hooks.onStop?.(verdict);
        return "stop";
      }
      case "stop":
        hooks.onStop?.(verdict);
        return "stop";
    }
  };
}

/** Format a USD amount for user-facing budget copy (e.g. "$1.20", "$0.0034"). */
export function formatBudgetUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "∞";
  if (usd === 0) return "$0.00";
  // Sub-cent turns are common; show enough precision to be meaningful.
  const decimals = usd < 0.1 ? 4 : 2;
  return `$${usd.toFixed(decimals)}`;
}

// ── Org / workspace governance ──────────────────────────────────────────────
// A per-turn budget can be governed at the org and workspace level, not just by
// the user. A governance policy is either a soft DEFAULT (seeds a member who
// hasn't set their own budget; the member may raise OR lower it) or a hard
// CEILING (clamps the member's effective budget — they cannot exceed it, and the
// enforcement mode can only get STRICTER, never laxer). This section is pure —
// the enforcement engine still consumes a single resolved TurnBudgetPolicy, so
// governance changes NOTHING downstream of {@link resolveEffectiveTurnBudget}.

/** How a governance policy relates to the member's own budget. */
export type BudgetEnforcementKind = "default" | "ceiling";

export interface GovernedBudget {
  policy: TurnBudgetPolicy;
  enforcement: BudgetEnforcementKind;
}

/** Strictness rank of a mode — a higher rank always wins on merge. */
const MODE_STRICTNESS: Record<TurnBudgetMode, number> = {
  grace: 0,
  prompt: 1,
  enforce: 2,
};

/** The stricter of two modes (enforce > prompt > grace). */
export function strictestMode(
  a: TurnBudgetMode,
  b: TurnBudgetMode,
): TurnBudgetMode {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

/** Apply one enabled ceiling to a base policy: clamp limit down, tighten mode, force on. */
function applyCeiling(
  base: TurnBudgetPolicy,
  ceiling: TurnBudgetPolicy,
): TurnBudgetPolicy {
  // A ceiling with no positive limit can't constrain a dollar amount — treat it
  // as "no ceiling" rather than forcing a $0 (turn-killing) budget.
  if (!ceiling.enabled || ceiling.limitUsd <= 0) return base;
  const baseLimit =
    base.enabled && base.limitUsd > 0
      ? base.limitUsd
      : Number.POSITIVE_INFINITY;
  const limitUsd = Math.min(baseLimit, ceiling.limitUsd);
  const mode = strictestMode(
    base.enabled ? base.mode : ceiling.mode,
    ceiling.mode,
  );
  // Only the grace cushion is meaningful when the resulting mode is grace; take
  // the tighter (smaller) cushion so a ceiling never loosens the overage window.
  const graceOveragePct =
    mode === "grace"
      ? Math.min(base.graceOveragePct, ceiling.graceOveragePct)
      : base.graceOveragePct;
  return { enabled: true, limitUsd, mode, graceOveragePct };
}

/**
 * Resolve the effective per-turn budget from the member's own policy plus
 * optional org and workspace governance. Precedence:
 *   1. Base = the member's policy (per-turn override or saved default).
 *   2. DEFAULTS apply only when the member has NOT opted in (base disabled):
 *      org default first, then workspace default (workspace wins).
 *   3. CEILINGS always apply and always clamp — limit is min()'d down and the
 *      mode can only get stricter. Org ceiling then workspace ceiling.
 * Governance the caller couldn't load should be passed as `null` (fail-open —
 * a broken governance row must never block a turn).
 */
export function resolveEffectiveTurnBudget(
  user: TurnBudgetPolicy,
  org: GovernedBudget | null,
  workspace: GovernedBudget | null,
): TurnBudgetPolicy {
  let effective: TurnBudgetPolicy = { ...user };

  // 2. Defaults — only seed a member who hasn't set their own budget.
  if (!effective.enabled) {
    if (org?.enforcement === "default" && org.policy.enabled)
      effective = { ...org.policy };
    if (workspace?.enforcement === "default" && workspace.policy.enabled)
      effective = { ...workspace.policy };
  }

  // 3. Ceilings — always clamp, strictest wins. Org then workspace.
  if (org?.enforcement === "ceiling")
    effective = applyCeiling(effective, org.policy);
  if (workspace?.enforcement === "ceiling")
    effective = applyCeiling(effective, workspace.policy);

  return effective;
}
