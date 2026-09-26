// The token figures Fleet shows (fleet.md, #3834): each row's total with the
// share of its input served from cache, and the Tokens shown tile over the
// rows a chip lists. Pure, so the cell, the tile and the sort read one
// computation.
//
// A row's figure is the rollup's count (`cost.run_totals`, by token class).
// While a run has no rollup row, the agent's own count stands in and says so,
// the way `shownCost` falls back to the reported cost. A run with neither
// reads "not recorded" and is left out of the sum, never counted as zero.
import {
  type Money,
  ratioOfMicros,
  shareOfMicros,
  sumMoney,
} from "@/data/contracts/money";
import type { RunRow } from "@/data/contracts/runs";

type ShownTokens = {
  /** Every token the run used, across every class. */
  total: number;
  /**
   * The share of input read from cache: cache reads over uncached input
   * plus cache reads. Null when the run read no input at all.
   */
  cached: number | null;
  /** True when the figure is the agent's own count, not the rollup's. */
  reported: boolean;
};

function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The figure a row shows, or null when nothing counted its tokens. */
export function shownTokens(run: RunRow): ShownTokens | null {
  const rolled = run.tokens ?? null;
  if (rolled !== null) {
    const total =
      rolled.inputUncached +
      rolled.cacheRead +
      rolled.cacheWrite5m +
      rolled.cacheWrite1h +
      rolled.output +
      rolled.reasoning;
    return {
      total,
      cached: shareOf(
        rolled.cacheRead,
        rolled.inputUncached + rolled.cacheRead,
      ),
      reported: false,
    };
  }
  const reported = run.reportedTokens ?? null;
  if (reported === null) return null;
  return {
    total:
      reported.input +
      reported.output +
      reported.cacheRead +
      reported.cacheWrite,
    cached: shareOf(reported.cacheRead, reported.input + reported.cacheRead),
    reported: true,
  };
}

/** The Tokens shown tile over the rows a chip lists. */
type TokensShown = {
  /** The sum over the rows with a figure; null when no row has one. */
  total: number | null;
  /** Rows with no figure, left out of `total`. */
  unrecorded: number;
  /** Rows whose figure is the agent's own count, counted in `total`. */
  reported: number;
  /**
   * The share of input served from cache over the rows listed, each row's
   * rollup rate weighted by its rollup cost. Null when no row carries both,
   * or the costs carry more than one currency.
   */
  servedFromCache: number | null;
};

/**
 * The spend-weighted cache rate: the sum of each row's cost times its rate,
 * over the sum of those costs. A row counts only when its rollup recorded
 * both, since the rate and the cost come from the same row. The arithmetic
 * is on micros in `money.ts`.
 */
function servedFromCache(rows: readonly { run: RunRow }[]): number | null {
  const costs: Money[] = [];
  const cached: Money[] = [];
  for (const { run } of rows) {
    const rate = run.cacheHitRate ?? null;
    if (rate === null || run.cost === null) continue;
    const share = shareOfMicros(run.cost, rate);
    if (share === null) continue;
    costs.push(run.cost);
    cached.push(share);
  }
  const whole = sumMoney(costs);
  const part = sumMoney(cached);
  if (whole === null || part === null) return null;
  return ratioOfMicros(part, whole);
}

export function tokensShown(rows: readonly { run: RunRow }[]): TokensShown {
  let total: number | null = null;
  let unrecorded = 0;
  let reported = 0;
  for (const { run } of rows) {
    const shown = shownTokens(run);
    if (shown === null) {
      unrecorded += 1;
      continue;
    }
    total = (total ?? 0) + shown.total;
    if (shown.reported) reported += 1;
  }
  return {
    total,
    unrecorded,
    reported,
    servedFromCache: servedFromCache(rows),
  };
}
