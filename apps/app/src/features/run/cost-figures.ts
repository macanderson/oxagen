// The Cost tab's own sums over `runMetrics` (pages/run.md, Cost). The metrics
// are the one derivation; this module only adds up what they already carry,
// so the instruments, the waterfall and the two tables below them print the
// same figure for the same thing and every total is the sum of its rows.
//
// Money is summed and divided only through `@/data/contracts/money` (INV-09).
// A figure a part is missing from is null, never a partial sum shown as the
// whole: a sum of the classes the book priced is not the cost of the classes
// it did not.
import {
  compareMicros,
  type Money,
  perMillionTokens,
  ratioOfMicros,
  shareOfMicros,
  sumMoney,
} from "@/data/contracts/money";
import {
  type PricedClasses,
  TOKEN_CLASSES,
  type TokenClass,
  type TokenFigures,
  type TurnFigure,
} from "./metrics";

const INPUT: readonly TokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
];
const OUTPUT: readonly TokenClass[] = ["output", "reasoning"];
const CACHE_WRITE: readonly TokenClass[] = ["cache_write_5m", "cache_write_1h"];

/** The classes' priced costs summed; null when any of them the book did not price. */
function priceOf(
  priced: PricedClasses | null,
  classes: readonly TokenClass[],
): Money | null {
  if (priced === null) return null;
  const parts: Money[] = [];
  for (const tokenClass of classes) {
    const part = priced.byClass[tokenClass];
    if (part === null) return null;
    parts.push(part);
  }
  return sumMoney(parts);
}

export type ClassPrices = {
  /** Every class priced: the total row of Spend by token class. */
  total: Money | null;
  /** The four input classes: what the six input areas cost together. */
  input: Money | null;
  /** Output and reasoning: the Model output area. */
  output: Money | null;
  /** The book's rate the input classes work out to, per million input tokens. */
  inputRate: Money | null;
  /** What the cache writes cost, of the total. */
  cacheWriteShare: number | null;
};

export function classPrices(
  priced: PricedClasses | null,
  tokens: TokenFigures | null,
): ClassPrices {
  const total = priceOf(priced, TOKEN_CLASSES);
  const input = priceOf(priced, INPUT);
  const writes = priceOf(priced, CACHE_WRITE);
  return {
    total,
    input,
    output: priceOf(priced, OUTPUT),
    inputRate:
      input === null || tokens === null
        ? null
        : perMillionTokens(input, tokens.input),
    cacheWriteShare:
      writes === null || total === null ? null : ratioOfMicros(writes, total),
  };
}

/** A class's cost as a share of the priced total; null when either is not priced. */
export function classShare(
  priced: PricedClasses | null,
  tokenClass: TokenClass,
  total: Money | null,
): number | null {
  const part = priced?.byClass[tokenClass] ?? null;
  if (part === null || total === null) return null;
  return ratioOfMicros(part, total);
}

type LedgerRow = TurnFigure & {
  /** The run's recorded cost before this turn and through it. */
  from: Money | null;
  to: Money | null;
};

export type Ledger = {
  rows: LedgerRow[];
  steps: number;
  modelSteps: number;
  toolSteps: number;
  frames: number;
  /**
   * Every turn's recorded cost summed; null when no turn carried one, or when
   * the turns carry more than one currency and no sum spans them.
   */
  cost: Money | null;
  /** The dearest turn's own cost, the scale the per-turn bars sit against. */
  max: Money | null;
  /** The 1-based position of the dearest turn in `rows`; null when none is priced. */
  dearest: number | null;
};

/**
 * The per-turn ledger with its running total and the sums the total row
 * prints. The running total is every cost record up to and through the turn,
 * which is what the contract's own `cumulativeCost` means: a turn whose cost
 * was not recorded adds nothing to it and says so in its own Cost cell, and
 * the run's figure before its first cost record is nothing spent in the
 * currency the records carry.
 */
export function ledgerOf(turns: readonly TurnFigure[]): Ledger {
  const priced = turns.flatMap((turn) =>
    turn.cost === null ? [] : [turn.cost],
  );
  const currency = priced[0]?.currency ?? null;
  let spent: Money | null =
    currency === null ? null : { micros: "0", currency };
  let max: Money | null = null;
  let dearest: number | null = null;
  const rows: LedgerRow[] = [];
  turns.forEach((turn, index) => {
    const from = spent;
    if (turn.cost !== null) {
      spent = spent === null ? null : sumMoney([spent, turn.cost]);
      if (
        max === null ||
        (turn.cost.currency === max.currency &&
          compareMicros(turn.cost, max) > 0)
      ) {
        max = turn.cost;
        dearest = index + 1;
      }
    }
    rows.push({ ...turn, from, to: spent });
  });
  return {
    rows,
    steps: turns.reduce((sum, turn) => sum + turn.steps, 0),
    modelSteps: turns.reduce((sum, turn) => sum + turn.modelSteps, 0),
    toolSteps: turns.reduce((sum, turn) => sum + turn.toolSteps, 0),
    frames: turns.reduce((sum, turn) => sum + turn.frames, 0),
    cost: sumMoney(priced),
    max,
    dearest,
  };
}

/** The run's cost spread evenly over its turns: the Cost so far instrument's "per turn". */
export function perTurn(cost: Money | null, turns: number): Money | null {
  if (cost === null || turns === 0) return null;
  return shareOfMicros(cost, 1 / turns);
}
