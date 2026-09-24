// The Cost tab's sums over `runMetrics`: the per-turn ledger with its running
// total, the priced classes added up for the total row, the input areas and
// Model output, and the effective input price. Every total here is a sum of
// the rows it heads, and a total a row is missing from is null, never a
// partial sum shown as the whole.
import { describe, expect, it } from "vitest";
import { classPrices, classShare, ledgerOf, perTurn } from "./cost-figures";
import type { PricedClasses, TokenFigures, TurnFigure } from "./metrics";

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});
const money = (micros: string) => ({ micros, currency: "USD" });

function turn(overrides: Partial<TurnFigure> = {}): TurnFigure {
  return {
    turn: 1,
    steps: 3,
    modelSteps: 1,
    toolSteps: 2,
    frames: 6,
    cost: usd("410000"),
    cacheHit: 0.87,
    seq: "1",
    ...overrides,
  };
}

function priced(
  overrides: Partial<PricedClasses["byClass"]> = {},
): PricedClasses {
  return {
    byClass: {
      input_uncached: money("622430"),
      cache_read: money("303892"),
      cache_write_5m: money("0"),
      cache_write_1h: money("0"),
      output: money("605725"),
      reasoning: money("312050"),
      ...overrides,
    },
    cacheSaved: money("2735028"),
  };
}

const TOKENS: TokenFigures = {
  total: 768_981,
  input: 732_270,
  output: 36_711,
  byClass: {
    input_uncached: 124_486,
    cache_read: 607_784,
    cache_write_5m: 0,
    cache_write_1h: 0,
    output: 24_229,
    reasoning: 12_482,
  },
};

describe("ledgerOf", () => {
  it("runs a total from nothing spent through every turn, and names the dearest", () => {
    const ledger = ledgerOf([
      turn({ turn: 1, seq: "1", cost: usd("410000") }),
      turn({ turn: 2, seq: "9", cost: usd("880000"), steps: 5, frames: 11 }),
      turn({ turn: 3, seq: "20", cost: usd("550000") }),
    ]);
    expect(
      ledger.rows.map((row) => [row.from?.micros, row.to?.micros]),
    ).toEqual([
      ["0", "410000"],
      ["410000", "1290000"],
      ["1290000", "1840000"],
    ]);
    expect(ledger.cost?.micros).toBe("1840000");
    expect(ledger.max?.micros).toBe("880000");
    expect(ledger.dearest).toBe(2);
    expect(ledger.steps).toBe(11);
    expect(ledger.frames).toBe(23);
    expect(ledger.modelSteps).toBe(3);
    expect(ledger.toolSteps).toBe(6);
  });

  it("adds nothing for a turn whose cost was not recorded, and never calls it the dearest (negative)", () => {
    const ledger = ledgerOf([
      turn({ turn: 1, seq: "1", cost: usd("410000") }),
      turn({ turn: 2, seq: "9", cost: null }),
      turn({ turn: 3, seq: "20", cost: usd("200000") }),
    ]);
    const [, unpriced, last] = ledger.rows;
    expect(unpriced?.cost).toBeNull();
    expect(unpriced?.from?.micros).toBe("410000");
    expect(unpriced?.to?.micros).toBe("410000");
    expect(last?.to?.micros).toBe("610000");
    expect(ledger.dearest).toBe(1);
    expect(ledger.cost?.micros).toBe("610000");
  });

  it("has no running total, no cost and no dearest turn when no turn carried a cost (negative)", () => {
    const ledger = ledgerOf([
      turn({ cost: null }),
      turn({ cost: null, seq: "4" }),
    ]);
    expect(
      ledger.rows.every((row) => row.from === null && row.to === null),
    ).toBe(true);
    expect(ledger.cost).toBeNull();
    expect(ledger.max).toBeNull();
    expect(ledger.dearest).toBeNull();
  });

  it("stops the running total where a second currency makes it no one figure (negative)", () => {
    const ledger = ledgerOf([
      turn({ cost: usd("410000") }),
      turn({
        seq: "4",
        cost: { micros: "100", currency: "EUR" },
      }),
    ]);
    expect(ledger.rows[1]?.to).toBeNull();
    expect(ledger.cost).toBeNull();
    expect(ledger.dearest).toBe(1);
  });
});

describe("classPrices", () => {
  it("sums every class for the total, the input four for the input areas and output with reasoning for Model output", () => {
    const prices = classPrices(priced(), TOKENS);
    expect(prices.total?.micros).toBe("1844097");
    expect(prices.input?.micros).toBe("926322");
    expect(prices.output?.micros).toBe("917775");
    // $0.926322 over 732,270 input tokens is $1.265000 a million, truncated.
    expect(prices.inputRate?.micros).toBe("1265000");
    expect(prices.cacheWriteShare).toBe(0);
  });

  it("answers a class's share of the priced total", () => {
    const prices = classPrices(priced(), TOKENS);
    expect(classShare(priced(), "output", prices.total)).toBeCloseTo(
      0.328467,
      5,
    );
  });

  it("prices no total and no input when the book left one input class unpriced (negative)", () => {
    const prices = classPrices(priced({ cache_read: null }), TOKENS);
    expect(prices.total).toBeNull();
    expect(prices.input).toBeNull();
    expect(prices.inputRate).toBeNull();
    expect(prices.cacheWriteShare).toBeNull();
    expect(prices.output?.micros).toBe("917775");
    expect(
      classShare(priced({ cache_read: null }), "output", prices.total),
    ).toBeNull();
  });

  it("prices nothing without a book (negative)", () => {
    expect(classPrices(null, TOKENS)).toEqual({
      total: null,
      input: null,
      output: null,
      inputRate: null,
      cacheWriteShare: null,
    });
  });

  it("has no effective input price when no input token was counted (negative)", () => {
    expect(classPrices(priced(), { ...TOKENS, input: 0 }).inputRate).toBeNull();
  });
});

describe("perTurn", () => {
  it("spreads the ledger's cost evenly over its turns", () => {
    expect(perTurn(usd("4130000"), 7)?.micros).toBe("589999");
  });

  it("answers nothing for no cost or no turns (negative)", () => {
    expect(perTurn(null, 7)).toBeNull();
    expect(perTurn(usd("4130000"), 0)).toBeNull();
  });
});
