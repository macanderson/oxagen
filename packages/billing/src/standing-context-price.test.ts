import { describe, expect, it } from "vitest";
import {
  ZERO_TOKENS,
  type CostBasis,
  type ModelBreakdown,
} from "./cost-rollup";
import type { PriceEntry } from "./price-book";
import {
  emptyWeekTally,
  priceAtPerThousand,
  resentSplitOf,
  runReadPrice,
  standingContextBySource,
  tallyWeek,
  weeklyCostOf,
  weeklyPriceFromBook,
  weeklyPriceOfTally,
  type WeekOfModel,
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

  it("is null when a model's cache reads include an unpriced call on a row with no priced tokens", () => {
    const partial = priced(30_000, 9_000n);
    partial.breakdown.models[0]!.hasUnpriced = true;
    expect(runReadPrice(partial)).toBeNull();
  });

  // #4572 item 7: the cost counts the priced calls alone, so the rate divides
  // it by their tokens. The old ratio read 9,000 over all 30,000 tokens.
  it("divides by the priced calls' tokens when a model has an unpriced call", () => {
    const partial = priced(30_000, 9_000n);
    const model = partial.breakdown.models[0]!;
    model.hasUnpriced = true;
    model.pricedTokens = { ...ZERO_TOKENS, cache_read: 20_000 };
    expect(runReadPrice(partial)).toEqual({ micros: 9_000n, tokens: 20_000n });
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

describe("the price of re-sent tokens", () => {
  const steering = {
    toolDefinitionTokens: null,
    contextFrameTokens: null,
    steeringTokens: 20_000,
  };

  it("does not fall back to the input price when the cache reads have no price", () => {
    const partial = { ...priced(30_000, 9_000n), modelCalls: 4 };
    const model = partial.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 9_000n };
    model.hasUnpriced = true;
    const part = standingContextBySource(partial, steering)?.steeringTokens;
    expect(part).toEqual({ resentTokens: 15_000, micros: null });
  });

  it("is the input price for a run that read nothing from the cache", () => {
    const run = { ...priced(0, 0n), modelCalls: 4 };
    const model = run.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 9_000n };
    model.costMicros = 9_000n;
    const part = standingContextBySource(run, steering)?.steeringTokens;
    expect(part).toEqual({ resentTokens: 15_000, micros: 45_000n });
  });

  it("has no price for a cache-free run whose uncached input includes an unpriced call on a row with no priced tokens", () => {
    const run = { ...priced(0, 0n), modelCalls: 4 };
    const model = run.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 6_000n };
    model.costMicros = 6_000n;
    model.hasUnpriced = true;
    const of = () => standingContextBySource(run, steering)?.steeringTokens;
    expect(of()?.micros).toBeNull();
    // A row stored before `hasUnpriced` existed marks it by a null cost.
    model.hasUnpriced = false;
    model.costMicros = null;
    expect(of()?.micros).toBeNull();
  });
});

const ORG = "00000000-0000-4000-8000-000000000001";
const RATE_CHANGE = new Date("2026-09-20T00:00:00.000Z");

function entry(
  overrides: Partial<PriceEntry> & Pick<PriceEntry, "id" | "tokenClass">,
): PriceEntry {
  return {
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...overrides,
  };
}

/** Input is $3 a million; reads are $0.30 before the change and $0.20 after. */
const BOOK: PriceEntry[] = [
  entry({ id: "pe_in", tokenClass: "input_uncached" }),
  entry({
    id: "pe_read_old",
    tokenClass: "cache_read",
    microsPerMillion: 300_000n,
    effectiveTo: RATE_CHANGE,
  }),
  entry({
    id: "pe_read_new",
    tokenClass: "cache_read",
    microsPerMillion: 200_000n,
    effectiveFrom: RATE_CHANGE,
  }),
];

/**
 * A model's week: a bucket for each group of cache reads, and the calls left
 * over as misses in one bucket at the week's last call.
 */
function week(
  model: string,
  calls: number,
  reads: readonly { calls: number; at: string }[],
): WeekOfModel {
  const read = reads.reduce((sum, r) => sum + r.calls, 0);
  return {
    model,
    calls,
    buckets: [
      ...reads.map((r) => ({
        calls: r.calls,
        cacheReadCalls: r.calls,
        firstSeen: r.at,
      })),
      ...(calls > read
        ? [
            {
              calls: calls - read,
              cacheReadCalls: 0,
              firstSeen: "2026-09-26T12:00:00.000Z",
            },
          ]
        : []),
    ],
  };
}

describe("weeklyPriceFromBook", () => {
  it("prices each request's re-read of 1,000 tokens at the read rate of its bucket", () => {
    // 1,000 reads at $0.30 and 1,000 at $0.20 a million tokens: 1,000 tokens
    // re-read 2,000 times cost 300,000 + 200,000 micros.
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 2_000, [
          { calls: 1_000, at: "2026-09-19T08:00:00.000Z" },
          { calls: 1_000, at: "2026-09-21T08:00:00.000Z" },
        ]),
      ],
      book: BOOK,
      orgId: ORG,
    });
    expect(price).toEqual({
      perThousandMicros: 500_000n,
      currency: "USD",
      requests: 2_000,
    });
  });

  it("prices a request that read nothing from the cache at the input rate", () => {
    // 100 reads at $0.20 and 10 misses at $3 a million: 20,000 + 30,000.
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 110, [
          { calls: 100, at: "2026-09-22T08:00:00.000Z" },
        ]),
      ],
      book: BOOK,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(50_000n);
    expect(price?.requests).toBe(110);
  });

  it("weights a week split across models by each model's requests", () => {
    const book = [
      ...BOOK,
      entry({
        id: "pe_haiku_read",
        model: "claude-haiku-5",
        tokenClass: "cache_read",
        microsPerMillion: 100_000n,
      }),
    ];
    // 1,000 sonnet reads at $0.20 and 9,000 haiku reads at $0.10 a million.
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 1_000, [
          { calls: 1_000, at: "2026-09-22T08:00:00.000Z" },
        ]),
        week("claude-haiku-5", 9_000, [
          { calls: 9_000, at: "2026-09-22T08:00:00.000Z" },
        ]),
      ],
      book,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(200_000n + 900_000n);
    expect(price?.requests).toBe(10_000);
  });

  // #4572 item 4: misses on both sides of an input rate change. The old
  // quote priced every miss at the model's last call, so both buckets read
  // $2 a million and the week read 400,000 micros.
  it("prices each bucket's misses at the input rate in force in that bucket", () => {
    const book = [
      entry({
        id: "pe_in_old",
        tokenClass: "input_uncached",
        effectiveTo: RATE_CHANGE,
      }),
      entry({
        id: "pe_in_new",
        tokenClass: "input_uncached",
        microsPerMillion: 2_000_000n,
        effectiveFrom: RATE_CHANGE,
      }),
      ...BOOK.filter((e) => e.tokenClass === "cache_read"),
    ];
    // 100 misses at $3 and 100 at $2 a million: 300,000 + 200,000 micros.
    const price = weeklyPriceFromBook({
      observed: [
        {
          model: "claude-sonnet-5",
          calls: 200,
          buckets: [
            {
              calls: 100,
              cacheReadCalls: 0,
              firstSeen: "2026-09-19T08:00:00.000Z",
            },
            {
              calls: 100,
              cacheReadCalls: 0,
              firstSeen: "2026-09-21T08:00:00.000Z",
            },
          ],
        },
      ],
      book,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(500_000n);
    expect(price?.requests).toBe(200);
  });

  it("prices a bucket's cache reads and its misses apart", () => {
    // 100 reads at $0.20 and 10 misses at $3 a million: 20,000 + 30,000.
    const price = weeklyPriceFromBook({
      observed: [
        {
          model: "claude-sonnet-5",
          calls: 110,
          buckets: [
            {
              calls: 110,
              cacheReadCalls: 100,
              firstSeen: "2026-09-22T08:00:00.000Z",
            },
          ],
        },
      ],
      book: BOOK,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(50_000n);
    expect(price?.requests).toBe(110);
  });

  // #4572 item 8: the quote left an unpriced request out and returned the
  // rest, 200,000 micros, so a provider's price read as a floor.
  it("is null when a request has no rate in the book, rather than a floor", () => {
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 1_000, [
          { calls: 1_000, at: "2026-09-22T08:00:00.000Z" },
        ]),
        week("in-house-model", 40, [
          { calls: 30, at: "2026-09-22T08:00:00.000Z" },
        ]),
      ],
      book: BOOK,
      orgId: ORG,
    });
    expect(price).toBeNull();
  });

  it("is null when the buckets do not hold every call", () => {
    const price = weeklyPriceFromBook({
      observed: [
        {
          model: "claude-sonnet-5",
          calls: 1_001,
          buckets: [
            {
              calls: 1_000,
              cacheReadCalls: 1_000,
              firstSeen: "2026-09-22T08:00:00.000Z",
            },
          ],
        },
      ],
      book: BOOK,
      orgId: ORG,
    });
    expect(price).toBeNull();
  });

  it("adds pages to one tally and rounds once", () => {
    const pages = [
      [
        week("claude-sonnet-5", 1_000, [
          { calls: 1_000, at: "2026-09-19T08:00:00.000Z" },
        ]),
      ],
      [
        week("claude-sonnet-5", 1_000, [
          { calls: 1_000, at: "2026-09-21T08:00:00.000Z" },
        ]),
      ],
    ];
    const tally = emptyWeekTally();
    for (const observed of pages)
      tallyWeek(tally, { observed, book: BOOK, orgId: ORG });
    expect(weeklyPriceOfTally(tally)).toEqual({
      perThousandMicros: 500_000n,
      currency: "USD",
      requests: 2_000,
    });
  });

  it("quotes free cache reads at zero", () => {
    const book = [
      entry({ id: "pe_in", tokenClass: "input_uncached" }),
      entry({ id: "pe_free", tokenClass: "cache_read", microsPerMillion: 0n }),
    ];
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 500, [
          { calls: 500, at: "2026-09-22T08:00:00.000Z" },
        ]),
      ],
      book,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(0n);
    expect(price?.requests).toBe(500);
  });

  it("is null when no request was priced or the rates name two currencies", () => {
    expect(weeklyPriceFromBook({ observed: [], book: BOOK, orgId: ORG })).toBe(
      null,
    );
    expect(
      weeklyPriceFromBook({
        observed: [week("in-house-model", 10, [])],
        book: BOOK,
        orgId: ORG,
      }),
    ).toBeNull();
    const book = [
      ...BOOK,
      entry({
        id: "pe_eur_read",
        model: "claude-haiku-5",
        tokenClass: "cache_read",
        currency: "EUR",
        microsPerMillion: 100_000n,
      }),
    ];
    expect(
      weeklyPriceFromBook({
        observed: [
          week("claude-sonnet-5", 10, [
            { calls: 10, at: "2026-09-22T08:00:00.000Z" },
          ]),
          week("claude-haiku-5", 10, [
            { calls: 10, at: "2026-09-22T08:00:00.000Z" },
          ]),
        ],
        book,
        orgId: ORG,
      }),
    ).toBeNull();
  });

  it("prices a negotiated read rate over the list rate", () => {
    const book = [
      ...BOOK,
      entry({
        id: "pe_own_read",
        orgId: ORG,
        tokenClass: "cache_read",
        microsPerMillion: 150_000n,
        source: "negotiated",
      }),
    ];
    const price = weeklyPriceFromBook({
      observed: [
        week("claude-sonnet-5", 1_000, [
          { calls: 1_000, at: "2026-09-22T08:00:00.000Z" },
        ]),
      ],
      book,
      orgId: ORG,
    });
    expect(price?.perThousandMicros).toBe(150_000n);
  });
});

describe("weeklyCostOf", () => {
  const price = { perThousandMicros: 48_000n, currency: "USD" };

  // list_records prices a record with this, and list_mcp_servers prices a
  // provider's 5,200 tokens as 249,600 micros: the same size, the same price.
  it("prices tokens at the week's price per 1,000, labelled estimated", () => {
    expect(weeklyCostOf(5_200, price)).toEqual({
      micros: "249600",
      currency: "USD",
      basis: "estimated",
    });
  });

  it("is null without the tokens or the price", () => {
    expect(weeklyCostOf(null, price)).toBeNull();
    expect(weeklyCostOf(5_200, null)).toBeNull();
  });
});

describe("priceAtPerThousand", () => {
  it("prices a count of tokens at a quoted price per 1,000, rounded half to even", () => {
    expect(priceAtPerThousand(300_000n, 4_000)).toBe(1_200_000n);
    expect(priceAtPerThousand(1n, 500)).toBe(0n);
    expect(priceAtPerThousand(1n, 1_500)).toBe(2n);
    expect(priceAtPerThousand(300_000n, 0)).toBe(0n);
  });
});

describe("resentSplitOf", () => {
  const none = {
    toolDefinitionTokens: null,
    contextFrameTokens: null,
    steeringTokens: null,
  };

  it("estimates a row with no stored split from the sums, less one call's share", () => {
    const run = { ...priced(30_000, 9_000n), modelCalls: 4 };
    const split = resentSplitOf(run, {
      ...none,
      toolDefinitionTokens: 80_000,
      steeringTokens: 20_000,
    });
    expect(split).toEqual({
      toolDefinitionTokens: { cached: 60_000, uncached: 0 },
      steeringTokens: { cached: 15_000, uncached: 0 },
      contextFrameTokens: null,
    });
    const once = { ...priced(0, 0n), modelCalls: 1 };
    const one = resentSplitOf(once, { ...none, steeringTokens: 5_000 });
    expect(one.steeringTokens).toEqual({ cached: 0, uncached: 0 });
  });

  it("reads the split the rollup stored over the estimate", () => {
    const run = { ...priced(30_000, 9_000n), modelCalls: 4 };
    const standing = {
      toolDefinitionTokens: { cached: 200, uncached: 100 },
      contextFrameTokens: null,
      steeringTokens: null,
    };
    const stored = { ...run, breakdown: { ...run.breakdown, standing } };
    const sums = { ...none, toolDefinitionTokens: 300 };
    expect(resentSplitOf(stored, sums)).toEqual(standing);
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

  // #4572 item 2: tool definitions of 0, 100, 100, and 100 tokens over four
  // calls. The calls after the first re-sent 300, and the old estimate from
  // the sum, 300 × 3 / 4, read 225.
  it("counts the re-sent tokens the rollup measured, whatever the first call held", () => {
    const run = { ...priced(30_000, 9_000n), modelCalls: 4 };
    const standing = {
      toolDefinitionTokens: { cached: 300, uncached: 0 },
      contextFrameTokens: null,
      steeringTokens: null,
    };
    const stored = { ...run, breakdown: { ...run.breakdown, standing } };
    const sums = {
      ...sources,
      toolDefinitionTokens: 300,
      steeringTokens: null,
    };
    const part = standingContextBySource(stored, sums)?.toolDefinitionTokens;
    // 300 tokens at 0.3 micros a token.
    expect(part).toEqual({ resentTokens: 300, micros: 90n });
  });

  // #4572 item 3: reads cost 0.3 micros a token and input 3. The old price
  // put all 40,000 tokens at the read rate, 12,000 micros.
  it("prices the tokens on calls that missed the cache at the input rate", () => {
    const run = { ...priced(30_000, 9_000n), modelCalls: 4 };
    const model = run.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 9_000n };
    model.costMicros = 18_000n;
    const standing = {
      toolDefinitionTokens: { cached: 30_000, uncached: 10_000 },
      contextFrameTokens: null,
      steeringTokens: null,
    };
    const stored = { ...run, breakdown: { ...run.breakdown, standing } };
    const sums = {
      ...sources,
      toolDefinitionTokens: 50_000,
      steeringTokens: null,
    };
    const part = standingContextBySource(stored, sums)?.toolDefinitionTokens;
    // 30,000 × 0.3 + 10,000 × 3 = 9,000 + 30,000 micros.
    expect(part).toEqual({ resentTokens: 40_000, micros: 39_000n });
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
