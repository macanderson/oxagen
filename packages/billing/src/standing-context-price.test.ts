import { describe, expect, it } from "vitest";
import {
  ZERO_TOKENS,
  type CostBasis,
  type ModelBreakdown,
} from "./cost-rollup";
import type { PriceEntry } from "./price-book";
import {
  priceAtPerThousand,
  resentStandingTokens,
  runReadPrice,
  standingContextBySource,
  standingReadPrice,
  weeklyPriceFromBook,
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

  it("is null for a cache-free run whose uncached input includes an unpriced call", () => {
    const run = priced(0, 0n);
    const model = run.breakdown.models[0]!;
    model.tokens = { ...model.tokens, input_uncached: 3_000 };
    model.costByClass = { ...model.costByClass, input_uncached: 6_000n };
    model.costMicros = 6_000n;
    model.hasUnpriced = true;
    expect(standingReadPrice(run)).toBeNull();
    // A row stored before `hasUnpriced` existed marks it by a null cost.
    model.hasUnpriced = false;
    model.costMicros = null;
    expect(standingReadPrice(run)).toBeNull();
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

function week(
  model: string,
  calls: number,
  reads: readonly { calls: number; at: string }[],
): WeekOfModel {
  return {
    model,
    calls,
    lastSeen: "2026-09-26T12:00:00.000Z",
    classes: reads.map((r) => ({
      tokenClass: "cache_read",
      calls: r.calls,
      firstSeen: r.at,
    })),
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
      unpricedRequests: 0,
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

  it("leaves out and counts a request the book has no rate for", () => {
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
    expect(price).toEqual({
      perThousandMicros: 200_000n,
      currency: "USD",
      requests: 1_000,
      unpricedRequests: 40,
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

describe("priceAtPerThousand", () => {
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
