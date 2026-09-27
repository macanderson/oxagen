import { describe, expect, it } from "vitest";
import {
  ZERO_TOKENS,
  type CostBasis,
  type ModelBreakdown,
} from "./cost-rollup";
import {
  priceAtPerThousand,
  resentStandingTokens,
  runReadPrice,
  standingContextBySource,
  standingReadPrice,
  weeklyPriceMicros,
  weeklyPricePerThousand,
} from "./standing-context-price";

function priced(
  cacheReadTokens: number,
  cacheReadMicros: bigint,
  costBasis: "gateway_observed" | "estimated" | null = "gateway_observed",
): { costBasis: CostBasis | null; breakdown: { models: ModelBreakdown[] } } {
  return {
    costBasis,
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 2,
          tokens: { ...ZERO_TOKENS, cache_read: cacheReadTokens },
          costMicros: cacheReadMicros,
          costByClass: {
            input_uncached: 0n,
            cache_read: cacheReadMicros,
            cache_write_5m: 0n,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
            server_tool_request: 0n,
          },
          cacheSavingMicros: 0n,
          basis: costBasis,
          hasUnpriced: false,
        },
      ],
    },
  };
}

describe("runReadPrice", () => {
  it("is the cache reads the rollup priced over the cache read tokens", () => {
    expect(runReadPrice(priced(30_000, 9_000n))).toEqual({
      micros: 9_000n,
      tokens: 30_000n,
    });
  });

  it("is null for an estimated or unpriced run, or a run that read no cache", () => {
    expect(runReadPrice(priced(30_000, 9_000n, "estimated"))).toBeNull();
    expect(runReadPrice(priced(30_000, 9_000n, null))).toBeNull();
    expect(runReadPrice(priced(0, 0n))).toBeNull();
  });

  it("is a zero price, not no price, for cache reads the book priced at nothing", () => {
    expect(runReadPrice(priced(30_000, 0n))).toEqual({
      micros: 0n,
      tokens: 30_000n,
    });
  });

  it("is null when a model's cache reads include an unpriced call", () => {
    const partial = priced(30_000, 9_000n);
    partial.breakdown.models[0]!.hasUnpriced = true;
    expect(runReadPrice(partial)).toBeNull();
  });

  it("ignores an unpriced model that read nothing from the cache", () => {
    const run = priced(30_000, 9_000n);
    run.breakdown.models.push({
      ...run.breakdown.models[0]!,
      model: "claude-haiku-5",
      tokens: { ...ZERO_TOKENS, input_uncached: 500 },
      costMicros: null,
      costByClass: { ...run.breakdown.models[0]!.costByClass, cache_read: 0n },
      hasUnpriced: true,
    });
    expect(runReadPrice(run)).toEqual({ micros: 9_000n, tokens: 30_000n });
  });
});

describe("standingReadPrice", () => {
  it("does not fall back to the input price when the cache reads have no price", () => {
    const partial = priced(30_000, 9_000n);
    const model = partial.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 9_000n };
    model.hasUnpriced = true;
    expect(standingReadPrice(partial)).toBeNull();
  });

  it("is the input price for a run that read nothing from the cache", () => {
    const run = priced(0, 0n);
    const model = run.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 9_000n };
    model.costMicros = 9_000n;
    expect(standingReadPrice(run)).toEqual({ micros: 9_000n, tokens: 3_000n });
  });
});

describe("the weekly price", () => {
  // 0.3 micros a read token.
  const price = { micros: 9_000n, tokens: 30_000n };

  it("is tokens times the read price times the requests of the week", () => {
    expect(weeklyPriceMicros(price, 1_000, 4_000)).toBe(1_200_000n);
    expect(weeklyPricePerThousand(price, 1_000)).toBe(300_000n);
  });

  it("prices a count of tokens at a quoted price per 1,000, rounded half to even", () => {
    expect(priceAtPerThousand(300_000n, 4_000)).toBe(1_200_000n);
    expect(priceAtPerThousand(1n, 500)).toBe(0n);
    expect(priceAtPerThousand(1n, 1_500)).toBe(2n);
    expect(priceAtPerThousand(300_000n, 0)).toBe(0n);
  });
});

describe("resentStandingTokens", () => {
  it("is the reported sources less the first call's share", () => {
    expect(
      resentStandingTokens(
        {
          toolDefinitionTokens: 80_000,
          contextFrameTokens: null,
          steeringTokens: 20_000,
        },
        4,
      ),
    ).toBe(75_000);
  });

  it("is null when no source reported, and 0 when the run made one call", () => {
    const none = {
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    };
    expect(resentStandingTokens(none, 4)).toBeNull();
    expect(resentStandingTokens({ ...none, steeringTokens: 5_000 }, 1)).toBe(
      0,
    );
  });
});

describe("standingContextBySource", () => {
  const sources = {
    toolDefinitionTokens: 80_000,
    contextFrameTokens: null,
    steeringTokens: 20_000,
  };

  it("prices each reported source's re-sent tokens at the cache read price", () => {
    expect(
      standingContextBySource(
        { ...priced(30_000, 9_000n), modelCalls: 4 },
        sources,
      ),
    ).toEqual({
      toolDefinitionTokens: { resentTokens: 60_000, micros: 18_000n },
      steeringTokens: { resentTokens: 15_000, micros: 4_500n },
      contextFrameTokens: null,
    });
  });

  it("falls back to the input price, and leaves the price out when the run has none", () => {
    const uncached = { ...priced(0, 0n), modelCalls: 4 };
    uncached.breakdown.models[0]!.tokens.input_uncached = 3_000;
    uncached.breakdown.models[0]!.costByClass.input_uncached = 9_000n;
    expect(
      standingContextBySource(uncached, sources)?.steeringTokens,
    ).toEqual({ resentTokens: 15_000, micros: 45_000n });
    expect(
      standingContextBySource(
        { ...priced(30_000, 9_000n, "estimated"), modelCalls: 4 },
        sources,
      )?.toolDefinitionTokens,
    ).toEqual({ resentTokens: 60_000, micros: null });
  });

  it("prices free cache reads at zero rather than leaving the price out", () => {
    expect(
      standingContextBySource(
        { ...priced(30_000, 0n), modelCalls: 4 },
        sources,
      ),
    ).toEqual({
      toolDefinitionTokens: { resentTokens: 60_000, micros: 0n },
      steeringTokens: { resentTokens: 15_000, micros: 0n },
      contextFrameTokens: null,
    });
  });

  it("is null when no source reported", () => {
    expect(
      standingContextBySource(
        { ...priced(30_000, 9_000n), modelCalls: 4 },
        {
          toolDefinitionTokens: null,
          contextFrameTokens: null,
          steeringTokens: null,
        },
      ),
    ).toBeNull();
  });
});
