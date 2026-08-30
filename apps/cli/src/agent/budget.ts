/**
 * budget.ts — CLI-side per-turn dollar budget: flag/slash parsing only.
 *
 * The canonical policy shape, the three enforcement modes, and the shared
 * evaluator/guard live in `@oxagen/billing` (packages/billing/src/turn-budget.ts)
 * — this module adapts HUMAN input (a `--budget`/`--budget-mode` flag value, a
 * `/budget …` slash argument string) into that shape. Kept pure (no state, no
 * I/O) so both the CLI flag parser (program.tsx) and the REPL's `/budget`
 * handler (interactive.tsx) share one grammar and a single test file exercises
 * it directly.
 *
 * The CLI budget is SESSION-SCOPED: no platform persistence, no auth call —
 * `program.tsx`/`interactive.tsx` just hold a `TurnBudgetPolicy` in memory for
 * the life of the process and hand it to `createTurnBudgetGuard` per turn.
 */
import {
  DEFAULT_GRACE_OVERAGE_PCT,
  DEFAULT_TURN_BUDGET_MODE,
  TURN_BUDGET_MODES,
  parseTurnBudgetMode,
  type TurnBudgetMode,
  type TurnBudgetPolicy,
} from "@oxagen/billing/turn-budget";

/** Parse `--budget <usd>` into a positive dollar amount, or null when invalid. */
export function parseBudgetFlag(raw: string): number | null {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Result of resolving the `--budget`/`--budget-mode` launch flags. */
export type BudgetFlagsResult =
  | { policy?: undefined; error?: undefined }
  | { policy: TurnBudgetPolicy; error?: undefined }
  | { policy?: undefined; error: string };

/**
 * Resolve the two launch flags into a policy. `--budget-mode` is ignored when
 * `--budget` is absent (per spec); when `--budget` is present without a mode,
 * it defaults to {@link DEFAULT_TURN_BUDGET_MODE}.
 */
export function resolveBudgetFlags(
  budgetRaw: string | undefined,
  modeRaw: string | undefined,
): BudgetFlagsResult {
  if (budgetRaw === undefined) return {};

  const limitUsd = parseBudgetFlag(budgetRaw);
  if (limitUsd === null) {
    return {
      error: `invalid --budget "${budgetRaw}". Use a positive USD amount, e.g. --budget 2.50.`,
    };
  }

  let mode: TurnBudgetMode = DEFAULT_TURN_BUDGET_MODE;
  if (modeRaw !== undefined) {
    const parsed = parseTurnBudgetMode(modeRaw);
    if (!parsed) {
      return {
        error:
          `invalid --budget-mode "${modeRaw}". Use ` +
          `${Object.keys(TURN_BUDGET_MODES).join(" | ")}.`,
      };
    }
    mode = parsed;
  }

  return {
    policy: {
      enabled: true,
      limitUsd,
      mode,
      graceOveragePct: DEFAULT_GRACE_OVERAGE_PCT,
    },
  };
}

/** Outcome of parsing a `/budget …` slash-command argument string. */
export type BudgetCommandResult =
  | { kind: "status" }
  | { kind: "off" }
  | { kind: "set"; policy: TurnBudgetPolicy }
  | { kind: "mode"; mode: TurnBudgetMode }
  | { kind: "invalid"; raw: string };

/**
 * Parse the text typed after `/budget` (already stripped of the command name,
 * NOT yet trimmed). Pure — no state, no I/O — grammar:
 *
 *   ""             → status (show the current policy)
 *   "status"       → status
 *   "off"          → disable
 *   "mode <mode>"  → change mode only, limit/enabled untouched
 *   "<usd>"        → enable at <usd>, mode defaults to DEFAULT_TURN_BUDGET_MODE
 *   "<usd> <mode>" → enable at <usd> with an explicit mode
 *   anything else  → invalid (caller shows the three modes' help text)
 */
export function parseBudgetCommand(argsRaw: string): BudgetCommandResult {
  const arg = argsRaw.trim();
  if (!arg || arg.toLowerCase() === "status") return { kind: "status" };
  if (arg.toLowerCase() === "off") return { kind: "off" };

  const modeMatch = /^mode\s+(\S+)$/i.exec(arg);
  if (modeMatch) {
    const mode = parseTurnBudgetMode(modeMatch[1]!);
    return mode ? { kind: "mode", mode } : { kind: "invalid", raw: arg };
  }

  const tokens = arg.split(/\s+/);
  if (tokens.length > 2) return { kind: "invalid", raw: arg };
  const [usdRaw, modeRaw] = tokens;
  const limitUsd = parseBudgetFlag(usdRaw!);
  if (limitUsd === null) return { kind: "invalid", raw: arg };

  let mode: TurnBudgetMode = DEFAULT_TURN_BUDGET_MODE;
  if (modeRaw !== undefined) {
    const parsed = parseTurnBudgetMode(modeRaw);
    if (!parsed) return { kind: "invalid", raw: arg };
    mode = parsed;
  }

  return {
    kind: "set",
    policy: {
      enabled: true,
      limitUsd,
      mode,
      graceOveragePct: DEFAULT_GRACE_OVERAGE_PCT,
    },
  };
}

/** One line per mode — shown whenever the user's `/budget` input is invalid. */
export function describeBudgetModes(): string {
  return Object.values(TURN_BUDGET_MODES)
    .map((m) => `  ${m.mode.padEnd(7)} ${m.label} — ${m.description}`)
    .join("\n");
}
