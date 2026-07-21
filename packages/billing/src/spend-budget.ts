/**
 * spend-budget.ts — the PURE core of the hard period-to-date spend ceiling
 * (OXA-1079). This module owns the budget's shape, the period-window math, the
 * threshold ladder, and the pure evaluator every surface runs, so a ceiling
 * behaves identically wherever it is read (the kernel gate, the app panel, the
 * CLI). No I/O, no clock of its own — the caller passes `now` — so the identical
 * decision runs everywhere and the whole module is unit-testable without a DB.
 *
 * This is a DIFFERENT axis from the per-turn dollar budget in ./turn-budget:
 * that caps ONE agent turn's cumulative cost inside the runCodingAgent loop;
 * THIS caps cumulative PERIOD spend for a whole org or workspace and is enforced
 * in the kernel invoke() admission path before any provider call.
 */

/** Window a ceiling is measured over. */
export type SpendBudgetPeriod = "monthly" | "rolling";

/** The scope a ceiling governs. */
export type SpendBudgetScope = "org" | "workspace";

/**
 * A resolved spend-budget config row (billing.spend_budgets). Micros are
 * micro-USD (1 USD = 1_000_000), consistent with token_usage.cost_usd_micros.
 */
export interface SpendBudget {
  scope: SpendBudgetScope;
  orgId: string;
  /** Null for an org-level ceiling; the workspace uuid for a workspace ceiling. */
  workspaceId: string | null;
  enabled: boolean;
  period: SpendBudgetPeriod;
  /** Trailing window length in days for `rolling`; null for `monthly`. */
  windowDays: number | null;
  limitMicros: bigint;
}

/** The inclusive-start/exclusive-end window a period spans, ending at `now`. */
export interface SpendBudgetWindow {
  start: Date;
  end: Date;
}

/**
 * The soft-threshold ladder (percent of the ceiling). Crossing one emits a
 * notification once per period; 100 is the hard stop where the gate denies.
 */
export const SPEND_BUDGET_THRESHOLDS = [50, 80, 95, 100] as const;
export type SpendBudgetThreshold = (typeof SPEND_BUDGET_THRESHOLDS)[number];

/** Position of period-to-date spend relative to its ceiling. */
export type SpendBudgetState =
  /** Under 50% — nothing to do. */
  | "ok"
  /** At/over 50% but under 80%. */
  | "threshold_50"
  /** At/over 80% but under 95%. */
  | "threshold_80"
  /** At/over 95% but under 100%. */
  | "threshold_95"
  /** At/over 100% — the gate denies. */
  | "exceeded";

export interface SpendBudgetVerdict {
  state: SpendBudgetState;
  /** True the instant spend reaches the ceiling — the gate denies. */
  overLimit: boolean;
  /** spent ÷ limit as a fraction (0..∞). */
  ratio: number;
  /** The highest ladder threshold spend has reached (0 when under 50%). */
  reachedThreshold: 0 | SpendBudgetThreshold;
  spentMicros: bigint;
  limitMicros: bigint;
}

/**
 * The window a ceiling is measured over, ending at `now`:
 *   - monthly → the first instant of the current UTC calendar month .. now
 *   - rolling → now − windowDays .. now
 * A rolling budget with a missing/non-positive windowDays falls back to a
 * 30-day window rather than throwing — a broken config must never wedge the
 * gate (the gate itself fails open on a load error, but this keeps the pure
 * math total).
 */
export function spendBudgetWindow(
  period: SpendBudgetPeriod,
  windowDays: number | null,
  now: Date,
): SpendBudgetWindow {
  if (period === "monthly") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    return { start, end: now };
  }
  const days = windowDays != null && windowDays > 0 ? windowDays : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end: now };
}

/**
 * The highest ladder threshold `ratio` (spent ÷ limit) has reached, or 0 when
 * under the lowest rung. Pure — powers both the notify watermark and the verdict.
 */
export function reachedSpendThreshold(ratio: number): 0 | SpendBudgetThreshold {
  let reached: 0 | SpendBudgetThreshold = 0;
  for (const t of SPEND_BUDGET_THRESHOLDS) {
    if (ratio * 100 >= t) reached = t;
  }
  return reached;
}

/**
 * Evaluate period-to-date spend against a ceiling. PURE. `overLimit` is true the
 * instant spend REACHES the ceiling (spent ≥ limit) — the guard denies there,
 * before the invocation's own provider cost is incurred.
 */
export function evaluateSpendBudget(args: {
  spentMicros: bigint;
  limitMicros: bigint;
}): SpendBudgetVerdict {
  const { spentMicros, limitMicros } = args;
  // A non-positive limit can't gate a dollar amount — treat as unbounded so a
  // corrupt row never denies every call. (The DB CHECK forbids limit ≤ 0; this
  // is defence in depth for the pure path.)
  if (limitMicros <= 0n) {
    return {
      state: "ok",
      overLimit: false,
      ratio: 0,
      reachedThreshold: 0,
      spentMicros,
      limitMicros,
    };
  }
  const ratio = Number(spentMicros) / Number(limitMicros);
  const reachedThreshold = reachedSpendThreshold(ratio);
  const overLimit = spentMicros >= limitMicros;
  const state: SpendBudgetState = overLimit
    ? "exceeded"
    : reachedThreshold === 95
      ? "threshold_95"
      : reachedThreshold === 80
        ? "threshold_80"
        : reachedThreshold === 50
          ? "threshold_50"
          : "ok";
  return {
    state,
    overLimit,
    ratio,
    reachedThreshold,
    spentMicros,
    limitMicros,
  };
}

/**
 * Thrown by the kernel budget gate when a scoped, metered invocation would run
 * under a scope whose period-to-date spend has reached its ceiling. Mirrors
 * InsufficientCreditsError / BillingSuspendedError: a plain Error subclass with a
 * stable `code` the surfaces duck-type (kernel catch → deny; Hono/MCP → 402), so
 * @oxagen/oxagen/kernel keeps no dependency on @oxagen/billing.
 */
export class BudgetExceededError extends Error {
  readonly code = "budget_exceeded" as const;
  readonly scope: SpendBudgetScope;
  readonly orgId: string;
  readonly workspaceId: string | null;
  readonly period: SpendBudgetPeriod;
  readonly limitMicros: bigint;
  readonly spentMicros: bigint;
  readonly capability: string;

  constructor(detail: {
    scope: SpendBudgetScope;
    orgId: string;
    workspaceId: string | null;
    period: SpendBudgetPeriod;
    limitMicros: bigint;
    spentMicros: bigint;
    capability: string;
  }) {
    super(
      `Spend budget exceeded: the ${detail.scope} ${detail.period} ceiling of ` +
        `${formatMicrosUsd(detail.limitMicros)} has been reached ` +
        `(period-to-date spend ${formatMicrosUsd(detail.spentMicros)}). ` +
        `Capability "${detail.capability}" is denied until the budget is raised or the period resets.`,
    );
    this.name = "BudgetExceededError";
    this.scope = detail.scope;
    this.orgId = detail.orgId;
    this.workspaceId = detail.workspaceId;
    this.period = detail.period;
    this.limitMicros = detail.limitMicros;
    this.spentMicros = detail.spentMicros;
    this.capability = detail.capability;
  }
}

/** Type guard — true when `err` is a BudgetExceededError (or duck-types as one). */
export function isBudgetExceeded(err: unknown): err is BudgetExceededError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "budget_exceeded"
  );
}

/** Format micro-USD as user-facing currency, e.g. 1_250_000n → "$1.25". */
export function formatMicrosUsd(micros: bigint): string {
  const usd = Number(micros) / 1_000_000;
  if (!Number.isFinite(usd)) return "∞";
  const decimals = Math.abs(usd) < 0.1 && usd !== 0 ? 4 : 2;
  return `$${usd.toFixed(decimals)}`;
}
