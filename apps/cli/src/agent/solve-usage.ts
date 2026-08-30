/**
 * Solve-path usage aggregation — makes `oxagen solve` cost-observable.
 *
 * A best-of-N run spends model calls in three places — the candidate turns, the
 * per-candidate pipeline judges, and the comparative selector — and all three go
 * through the injected `AgentAi` port, where `createMeteredAi` already prices
 * each call into a {@link MetricsEvent}. This module folds that stream into
 * totals and renders them two ways: as structured fields on the headless result
 * envelope, and as a one-line roll-up in the same textual shape as the one-shot
 * `--verbose` summary.
 *
 * Keep that line's shape. The bench adapter (`bench/terminal-bench/src/
 * oxagen_terminal_bench/oxagen_agent.py`) parses it with the regexes
 * `([\d.]+)s total\D+([\d,]+)\s*tok\D+\$([\d.]+)` and `(\d+)\s*steps`.
 */
import type { MetricsEvent } from "./metrics.js";
import type { BestOfNResult } from "./best-of-n.js";

/** Running totals across every model call a solve run makes. */
export interface SolveUsageTotals {
  tokensIn: number;
  tokensOut: number;
  /** Subset of `tokensIn` served from provider prompt caches. */
  cachedTokens: number;
  /** Rate-card-priced (cache-discounted) cost across all calls. */
  costUsd: number;
  /** Number of model calls folded in. */
  modelCalls: number;
}

export interface SolveUsageAccumulator {
  /** Fold one priced call. Tool-call events are ignored (no token usage). */
  record: (ev: MetricsEvent) => void;
  /** Snapshot of the totals so far (a copy — safe to hold). */
  totals: () => SolveUsageTotals;
}

/** Create a fresh accumulator; wire `record` into `createMeteredAi`'s `onMetrics`. */
export function createSolveUsageAccumulator(): SolveUsageAccumulator {
  const t: SolveUsageTotals = {
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    modelCalls: 0,
  };
  return {
    record(ev: MetricsEvent): void {
      if (ev.kind !== "model_call") return;
      t.tokensIn += ev.tokensIn;
      t.tokensOut += ev.tokensOut;
      t.cachedTokens += ev.cachedTokens;
      t.costUsd += ev.costUsd;
      t.modelCalls += 1;
    },
    totals: () => ({ ...t }),
  };
}

/** The full summary emitted on the result envelope and the roll-up line. */
export interface SolveUsageSummary extends SolveUsageTotals {
  /** tokensIn + tokensOut. */
  totalTokens: number;
  /** Tool-loop steps across every candidate (plus the fork-mode trunk). */
  steps: number;
  /** Wall-clock seconds for the whole race. */
  wallSec: number;
}

/** Sum tool-loop steps across all candidates, plus fork mode's trunk turn. */
export function totalSolveSteps(result: BestOfNResult): number {
  const candidateSteps = result.candidates.reduce(
    (sum, c) => sum + (c.steps || 0),
    0,
  );
  return candidateSteps + (result.forkTelemetry?.trunkSteps ?? 0);
}

/** Assemble the summary from settled totals + the race result + wall time. */
export function buildSolveUsageSummary(
  totals: SolveUsageTotals,
  result: BestOfNResult,
  wallMs: number,
): SolveUsageSummary {
  return {
    ...totals,
    totalTokens: totals.tokensIn + totals.tokensOut,
    steps: totalSolveSteps(result),
    wallSec: Math.max(0, wallMs) / 1000,
  };
}

/**
 * One-line roll-up in the SAME shape as the one-shot `--verbose` efficiency
 * summary, so the bench adapter's existing regexes
 * (`([\d.]+)s total\D+([\d,]+)\s*tok\D+\$([\d.]+)` and `(\d+)\s*steps`) match
 * solve output without modification.
 */
export function formatSolveRollup(s: SolveUsageSummary): string {
  return `${s.wallSec.toFixed(2)}s total · ${s.totalTokens} tok · $${s.costUsd.toFixed(4)} · ${s.steps} steps`;
}
