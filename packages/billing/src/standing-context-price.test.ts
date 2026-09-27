import { describe, expect, it } from "vitest";
import { ZERO_TOKENS } from "./cost-rollup";
import {
  priceAtPerThousand,
  resentStandingTokens,
  runReadPrice,
  weeklyPriceMicros,
  weeklyPricePerThousand,
} from "./standing-context-price";

function priced(
  cacheReadTokens: number,
  cacheReadMicros: bigint,
  costBasis: "gateway_observed" | "estimated" | null = "gateway_observed",
) {
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

  it("is null when no source reported or the run made one call", () => {
    const none = {
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    };
    expect(resentStandingTokens(none, 4)).toBeNull();
    expect(
      resentStandingTokens({ ...none, steeringTokens: 5_000 }, 1),
    ).toBeNull();
  });
});
