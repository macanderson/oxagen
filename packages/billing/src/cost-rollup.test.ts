import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  dailyTotalsFromRuns,
  divideHalfEven,
  microsToCentsHalfEven,
  priceFrame,
  priceInputTokens,
  rollupRun,
  runInputPrice,
  type ModelCallFrame,
  type RunMeta,
  type RunTotalsRecord,
  type TokenCounts,
  type ToolCallFrame,
  UNASSIGNED_COST_CENTER_KEY,
  ZERO_TOKENS,
} from "./cost-rollup";
import type { PriceEntry } from "./price-book";
import {
  inCodeCardPrices,
  mergePublishedPrices,
  seedsFromPublishedPrices,
} from "./price-sources";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";

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

/** Sonnet list prices: $3 input, $15 output, $0.30 cache read, $3.75 cache write. */
const BOOK: PriceEntry[] = [
  entry({ id: "pe_in", tokenClass: "input_uncached" }),
  entry({ id: "pe_out", tokenClass: "output", microsPerMillion: 15_000_000n }),
  entry({ id: "pe_cr", tokenClass: "cache_read", microsPerMillion: 300_000n }),
  entry({
    id: "pe_cw",
    tokenClass: "cache_write_5m",
    microsPerMillion: 3_750_000n,
  }),
];

function tokens(partial: Partial<TokenCounts>): TokenCounts {
  return { ...ZERO_TOKENS, ...partial };
}

/** A tool call that ran and returned, its outcome and result unrecorded unless a test says. */
function tool(
  name: string | null,
  overrides: Partial<ToolCallFrame> = {},
): ToolCallFrame {
  return {
    name,
    status: "ok",
    inputDigest: null,
    outputDigest: null,
    isMutating: null,
    resultTokens: null,
    ...overrides,
  };
}

function frame(overrides: Partial<ModelCallFrame> = {}): ModelCallFrame {
  return {
    at: new Date("2026-09-14T10:00:00.000Z"),
    model: "claude-sonnet-5",
    provider: "anthropic",
    tokens: tokens({ input_uncached: 1000, output: 100 }),
    reportedCostMicros: 4500n,
    basis: "gateway_observed",
    ...overrides,
  };
}

const meta: RunMeta = {
  runId: "tse_run1",
  runSource: "tacho",
  orgId: ORG,
  workspaceId: WS,
  operatorPrincipalId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  operatorKey: "prn_0123456789abcdefghjkmn",
  agentPrincipalId: "pr-agent",
  agentKey: "acme.core.cc",
  taskRef: null,
  costCenter: null,
  startedAt: new Date("2026-09-14T09:59:00.000Z"),
  sealedAt: new Date("2026-09-14T10:05:00.000Z"),
  turns: 2,
  retries: 0,
  enforcementTier: "observe",
  replayGrade: "inspect",
};

describe("half-even rounding", () => {
  it("rounds a half to the even neighbour and everything else to the nearest", () => {
    expect(divideHalfEven(5n, 10n)).toBe(0n);
    expect(divideHalfEven(15n, 10n)).toBe(2n);
    expect(divideHalfEven(25n, 10n)).toBe(2n);
    expect(divideHalfEven(26n, 10n)).toBe(3n);
    expect(divideHalfEven(-25n, 10n)).toBe(-2n);
    expect(microsToCentsHalfEven(125_000n)).toBe(12n);
    expect(microsToCentsHalfEven(135_000n)).toBe(14n);
    expect(microsToCentsHalfEven(135_001n)).toBe(14n);
  });
});

describe("priceFrame", () => {
  it("prices every class at the entry effective at the frame's instant", () => {
    const older = entry({
      id: "pe_in_old",
      tokenClass: "input_uncached",
      microsPerMillion: 2_000_000n,
      effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-01-01T00:00:00.000Z"),
    });
    const p = priceFrame([...BOOK, older], ORG, frame());
    // 1000 × 3_000_000 + 100 × 15_000_000, a million times the micros.
    expect(p.scaled).toBe(4_500_000_000n);
    expect(p.basis).toBe("gateway_observed");
    expect(p.priceEntryIds.sort()).toEqual(["pe_in", "pe_out"]);

    const before = priceFrame([...BOOK, older], ORG, {
      ...frame(),
      at: new Date("2025-06-01T00:00:00.000Z"),
    });
    expect(before.priceEntryIds).toEqual(["pe_in_old"]);
    expect(before.basis).toBe("estimated");
  });

  it("marks a frame whose model no entry prices as estimated and keeps its reported figure", () => {
    const p = priceFrame(
      BOOK,
      ORG,
      frame({ model: "mystery-9", reportedCostMicros: 777n }),
    );
    expect(p.basis).toBe("estimated");
    expect(p.scaled).toBe(777_000_000n);
    expect(p.priceEntryIds).toEqual([]);
  });

  it("leaves a frame unpriced when no entry prices its model and it reports no figure", () => {
    const p = priceFrame(
      BOOK,
      ORG,
      frame({ model: "mystery-9", reportedCostMicros: null }),
    );
    expect(p.scaled).toBe(null);
    expect(p.basis).toBe(null);
    expect(p.priceEntryIds).toEqual([]);
  });

  it("keeps the classes the book priced as an estimate when the rest is unpriced", () => {
    const p = priceFrame(
      BOOK,
      ORG,
      frame({
        tokens: tokens({ input_uncached: 1000, reasoning: 50 }),
        reportedCostMicros: null,
      }),
    );
    expect(p.scaled).toBe(3_000_000_000n);
    expect(p.basis).toBe("estimated");
    expect(p.priceEntryIds).toEqual(["pe_in"]);
  });

  it("prefers the organization's negotiated row over the list row", () => {
    const negotiated = entry({
      id: "pe_neg",
      tokenClass: "input_uncached",
      orgId: ORG,
      source: "negotiated",
      microsPerMillion: 1_000_000n,
    });
    const p = priceFrame(
      [...BOOK, negotiated],
      ORG,
      frame({ tokens: tokens({ input_uncached: 1000 }) }),
    );
    expect(p.scaled).toBe(1_000_000_000n);
    expect(p.priceEntryIds).toEqual(["pe_neg"]);
    const other = priceFrame(
      [...BOOK, negotiated],
      "other-org",
      frame({ tokens: tokens({ input_uncached: 1000 }) }),
    );
    expect(other.priceEntryIds).toEqual(["pe_in"]);
  });
});

describe("cacheHitRate", () => {
  it("weights each frame's rate by its spend", () => {
    const rate = cacheHitRate([
      { tokens: tokens({ input_uncached: 100, cache_read: 100 }), scaled: 3n },
      { tokens: tokens({ input_uncached: 100, cache_read: 0 }), scaled: 1n },
    ]);
    expect(rate).toBeCloseTo((0.5 * 3 + 0 * 1) / 4, 10);
  });

  it("falls back to token weighting when nothing cost anything and is null without input", () => {
    expect(
      cacheHitRate([
        {
          tokens: tokens({ input_uncached: 100, cache_read: 300 }),
          scaled: 0n,
        },
      ]),
    ).toBe(0.75);
    expect(cacheHitRate([{ tokens: tokens({ output: 10 }), scaled: 5n }])).toBe(
      null,
    );
    expect(cacheHitRate([])).toBe(null);
  });
});

describe("rollupRun", () => {
  it("sums frames at full precision and rounds once to micros", () => {
    // Three frames of 1 input token at $3/M: 3 micros each exactly, and one
    // of 1 token at $0.30/M cache read: 0.3 micros. Total 9.3 → 9 micros.
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({ tokens: tokens({ input_uncached: 1 }) }),
        frame({ tokens: tokens({ input_uncached: 1 }) }),
        frame({ tokens: tokens({ input_uncached: 1 }) }),
        frame({ tokens: tokens({ cache_read: 1 }) }),
      ],
    });
    expect(record.costMicros).toBe(9n);
    expect(record.costBasis).toBe("gateway_observed");
    expect(record.modelCalls).toBe(4);
    expect(record.steps).toBe(4);
    expect(record.tokens).toEqual(tokens({ input_uncached: 3, cache_read: 1 }));
    expect(record.priceEntryIds).toEqual(["pe_cr", "pe_in"]);
  });

  it("splits each model's cost by token class, rounded once per class", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({
          tokens: tokens({
            input_uncached: 1000,
            cache_write_5m: 1000,
            output: 100,
          }),
        }),
      ],
    });
    const sonnet = record.breakdown.models[0]!;
    expect(sonnet.costByClass).toEqual({
      input_uncached: 3000n,
      cache_read: 0n,
      cache_write_5m: 3750n,
      cache_write_1h: 0n,
      output: 1500n,
      reasoning: 0n,
      server_tool_request: 0n,
    });
    expect(sonnet.costMicros).toBe(8250n);
  });

  it("reports mixed when a run's frames were observed by different parties", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({ basis: "gateway_observed" }),
        frame({ basis: "client_attested" }),
      ],
    });
    expect(record.costBasis).toBe("mixed");
  });

  it("reports estimated for a run with a model no price entry prices", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame(),
        frame({ model: "mystery-9", reportedCostMicros: 500n }),
      ],
    });
    expect(record.costBasis).toBe("estimated");
    expect(record.costMicros).toBe(4500n + 500n);
    expect(record.breakdown.models.map((m) => [m.model, m.basis])).toEqual([
      ["claude-sonnet-5", "gateway_observed"],
      ["mystery-9", "estimated"],
    ]);
  });

  it("answers no cost and no basis for a run whose only frames are unpriced, never a zero", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({ model: "mystery-9", reportedCostMicros: null }),
        frame({ model: "mystery-9", reportedCostMicros: null }),
      ],
    });
    expect(record.costMicros).toBe(null);
    expect(record.costBasis).toBe(null);
    expect(record.modelCalls).toBe(2);
    expect(record.tokens).toEqual(
      tokens({ input_uncached: 2000, output: 200 }),
    );
    expect(record.priceEntryIds).toEqual([]);
    expect(record.breakdown.models).toEqual([
      expect.objectContaining({
        model: "mystery-9",
        calls: 2,
        costMicros: null,
        basis: null,
        hasUnpriced: true,
      }),
    ]);
  });

  it("prices the run from its priced frames alone when one frame is unpriced", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame(),
        frame({ model: "mystery-9", reportedCostMicros: null }),
      ],
    });
    expect(record.costMicros).toBe(4500n);
    expect(record.costBasis).toBe("gateway_observed");
    expect(record.modelCalls).toBe(2);
    expect(
      record.breakdown.models.map((m) => [m.model, m.costMicros, m.basis]),
    ).toEqual([
      ["claude-sonnet-5", 4500n, "gateway_observed"],
      ["mystery-9", null, null],
    ]);
    expect(
      record.breakdown.models.map((m) => [m.model, m.hasUnpriced]),
    ).toEqual([
      ["claude-sonnet-5", false],
      ["mystery-9", true],
    ]);
  });

  it("marks a model group unpriced when one of its own calls is, even though a sibling call to the same model priced (#3271 residue G2)", () => {
    // Fresh evidence: rollupRun aggregates a model group's costMicros across
    // every call to that model, so a group with one priced and one unpriced
    // call to the SAME model still carries a non-null costMicros — reading
    // as fully priced on that field alone, even though it is not. This test
    // fails against the code before hasUnpriced existed, because that code
    // had no field the reprice scan could read to tell the two cases apart.
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame(),
        frame({
          tokens: tokens({ reasoning: 500 }),
          reportedCostMicros: null,
        }),
      ],
    });
    expect(record.breakdown.models).toHaveLength(1);
    const [group] = record.breakdown.models;
    // The group's own cost total is non-null: one of its two calls priced.
    expect(group!.costMicros).toBe(4500n);
    expect(group!.calls).toBe(2);
    // But it is not fully priced, and only this field says so.
    expect(group!.hasUnpriced).toBe(true);
  });

  it("answers no cost and no basis for a run with no model frame, never a zero", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [tool("Bash"), tool(null)],
      modelCalls: [],
    });
    expect(record.costMicros).toBe(null);
    expect(record.costBasis).toBe(null);
    expect(record.cacheHitRate).toBe(null);
    expect(record.toolCalls).toBe(2);
    expect(record.breakdown.tools).toEqual([
      { name: "Bash", calls: 1, resultTokens: null, costMicros: null },
    ]);
    expect(record.breakdown.models).toEqual([]);
  });

  it("carries the verdict and the acceptance it was handed", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
      carried: { verdict: "flipped", accepted: true },
    });
    expect(record.verdict).toBe("flipped");
    expect(record.accepted).toBe(true);
    const fresh = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
    });
    expect(fresh.verdict).toBe(null);
    expect(fresh.accepted).toBe(null);
  });
});

describe("the graded steps (#3984, ADR-199)", () => {
  const read = (input: string, over: Partial<ToolCallFrame> = {}) =>
    tool("Read", {
      inputDigest: input,
      outputDigest: "sha256:out",
      isMutating: false,
      ...over,
    });

  it("counts advanced and unproductive steps that sum to the run's steps", () => {
    const record = rollupRun({
      meta: { ...meta, retries: 1 },
      book: BOOK,
      modelCalls: [frame(), frame(), frame()],
      toolCalls: [
        read("sha256:a"),
        read("sha256:a"),
        read("sha256:b", { status: "error" }),
        read("sha256:c"),
      ],
    });
    expect(record.steps).toBe(7);
    expect(record.breakdown.steps).toEqual({
      failed: 1,
      repeated: 1,
      retried: 1,
    });
    expect(record.unproductiveSteps).toBe(3);
    expect(record.advancedSteps).toBe(4);
    expect((record.advancedSteps ?? 0) + (record.unproductiveSteps ?? 0)).toBe(
      record.steps,
    );
    expect(record.productiveRatio).toBeCloseTo(4 / 7, 12);
  });

  it("computes the ratio from the frames, not from a carried value", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [frame()],
      toolCalls: [read("sha256:a")],
      carried: { verdict: null, accepted: null },
    });
    expect(record.productiveRatio).toBe(1);
  });

  it("leaves a run with no step ungraded, all three null", () => {
    const record = rollupRun({ meta, book: BOOK, toolCalls: [], modelCalls: [] });
    expect(record.steps).toBe(0);
    expect(record.productiveRatio).toBeNull();
    expect(record.advancedSteps).toBeNull();
    expect(record.unproductiveSteps).toBeNull();
    expect(record.breakdown.steps).toBeNull();
  });
});

describe("each tool's result cost (#3892, ADR-199)", () => {
  /** 10,000 input tokens at $3 a million: 30,000 micros, so 3 micros a token. */
  const priced = frame({
    tokens: tokens({ input_uncached: 10_000, output: 100 }),
  });

  it("prices each tool's result tokens at the run's uncached input rate", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [priced],
      toolCalls: [
        tool("Read", { resultTokens: 1_200 }),
        tool("Read", { resultTokens: 300 }),
        tool("Grep", { resultTokens: 50 }),
      ],
    });
    expect(record.breakdown.tools).toEqual([
      { name: "Grep", calls: 1, resultTokens: 50, costMicros: 150n },
      { name: "Read", calls: 2, resultTokens: 1_500, costMicros: 4_500n },
    ]);
  });

  it("attributes input the run's cost already counts, never adding to it", () => {
    const without = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [priced],
      toolCalls: [tool("Read")],
    });
    const withResults = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [priced],
      toolCalls: [tool("Read", { resultTokens: 1_200 })],
    });
    expect(withResults.costMicros).toBe(without.costMicros);
  });

  it("keeps a client-attested run's own basis on its total", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [{ ...priced, basis: "client_attested" }],
      toolCalls: [tool("Read", { resultTokens: 1_200 })],
    });
    // The tool figure is the contract's `estimated`, applied where the
    // handler maps it; the run's own figure keeps who observed it.
    expect(record.costBasis).toBe("client_attested");
    expect(record.breakdown.tools[0]?.costMicros).toBe(3_600n);
  });

  it("answers no cost for a tool whose calls recorded no result tokens", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [priced],
      toolCalls: [tool("Bash"), tool("Bash")],
    });
    expect(record.breakdown.tools).toEqual([
      { name: "Bash", calls: 2, resultTokens: null, costMicros: null },
    ]);
  });

  it("answers no cost for an estimated run, which has no input price to apply", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [
        priced,
        frame({ model: "mystery-9", reportedCostMicros: 500n }),
      ],
      toolCalls: [tool("Read", { resultTokens: 1_200 })],
    });
    expect(record.costBasis).toBe("estimated");
    expect(record.breakdown.tools[0]).toEqual({
      name: "Read",
      calls: 1,
      resultTokens: 1_200,
      costMicros: null,
    });
  });

  it("prices one token by the rule the findings job uses", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      modelCalls: [priced],
      toolCalls: [tool("Read", { resultTokens: 7 })],
    });
    const price = runInputPrice(record);
    expect(price).toEqual({ micros: 30_000n, tokens: 10_000n });
    expect(price === null ? null : priceInputTokens(price, 7)).toBe(
      record.breakdown.tools[0]?.costMicros,
    );
  });
});

describe("provider-side web searches (#3721)", () => {
  // A wrapped call reports the web searches it ran, and the vendor bills each
  // one: Anthropic charges $10 per 1,000, which is 10_000_000_000 micros per
  // million requests.
  const search = entry({
    id: "pe_search",
    tokenClass: "server_tool_request",
    unit: "request",
    microsPerMillion: 10_000_000_000n,
  });
  const searching = frame({
    tokens: tokens({ input_uncached: 1000, output: 200, server_tool_request: 3 }),
    reportedCostMicros: null,
    basis: "client_attested",
  });

  it("prices a run's searches into its cost and its search class", () => {
    const record = rollupRun({
      meta,
      book: [...BOOK, search],
      toolCalls: [],
      modelCalls: [searching],
    });
    const model = record.breakdown.models[0]!;
    // 3 requests at $0.01 each.
    expect(model.costByClass.server_tool_request).toBe(30_000n);
    // 1000 input at $3 and 200 output at $15 a million, plus the searches.
    expect(record.costMicros).toBe(3_000n + 3_000n + 30_000n);
    expect(record.costBasis).toBe("client_attested");
    expect(record.tokens.server_tool_request).toBe(3);
    expect(record.priceEntryIds).toContain("pe_search");
  });

  it("prices them from the in-code card's seeded rate, so a searching run stays client_attested", () => {
    // Before the card seeded a search rate, every call that searched missed
    // the class and read `estimated`, and its search charge was never priced.
    // The sync's own path: merge the sources, then seed the winners.
    const book: PriceEntry[] = seedsFromPublishedPrices(
      mergePublishedPrices([inCodeCardPrices()]).prices,
      new Date("2026-01-01T00:00:00.000Z"),
    ).map((seed, i) => ({
      ...seed,
      id: `pe_${i}`,
      orgId: null,
      source: seed.source ?? "list",
    }));
    const p = priceFrame(book, ORG, searching);
    expect(p.basis).toBe("client_attested");
    expect(p.scaledByClass.server_tool_request).toBe(30_000_000_000n);
  });
});

describe("the recorded cache saving (#4069)", () => {
  /** The input rate rises from $3 to $4 at this instant; cache reads stay $0.30. */
  const RATE_CHANGE = new Date("2026-09-15T00:00:00.000Z");
  const REPRICED: PriceEntry[] = [
    entry({
      id: "pe_in_old",
      tokenClass: "input_uncached",
      effectiveTo: RATE_CHANGE,
    }),
    entry({
      id: "pe_in_new",
      tokenClass: "input_uncached",
      microsPerMillion: 4_000_000n,
      effectiveFrom: RATE_CHANGE,
    }),
    ...BOOK.filter((e) => e.tokenClass !== "input_uncached"),
  ];

  it("prices each frame's saving at that frame's instant", () => {
    // Fails on main: the rollup recorded no saving, so a reader repriced the
    // cache reads with today's book and printed 7400 for both frames.
    const record = rollupRun({
      meta,
      book: REPRICED,
      toolCalls: [],
      modelCalls: [
        frame({
          at: new Date("2026-09-14T10:00:00.000Z"),
          tokens: tokens({ input_uncached: 10, cache_read: 1000 }),
        }),
        frame({
          at: new Date("2026-09-16T10:00:00.000Z"),
          tokens: tokens({ input_uncached: 10, cache_read: 1000 }),
        }),
      ],
    });
    // 1000 × (3.00 − 0.30) + 1000 × (4.00 − 0.30), in micros.
    expect(record.breakdown.models[0]!.cacheSavingMicros).toBe(2700n + 3700n);
  });

  it("rounds the model's saving once, like its cost by class", () => {
    // Each frame saves 2.7 micros; per-frame rounding would record 6.
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({ tokens: tokens({ cache_read: 1 }) }),
        frame({ tokens: tokens({ cache_read: 1 }) }),
      ],
    });
    expect(record.breakdown.models[0]!.cacheSavingMicros).toBe(5n);
  });

  it("records a zero saving for a model that never read the cache", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
    });
    expect(record.breakdown.models[0]!.cacheSavingMicros).toBe(0n);
  });

  it("records no saving when a frame that read the cache has no cache_read price", () => {
    const record = rollupRun({
      meta,
      book: BOOK.filter((e) => e.tokenClass !== "cache_read"),
      toolCalls: [],
      modelCalls: [
        frame(),
        frame({ tokens: tokens({ input_uncached: 10, cache_read: 1000 }) }),
      ],
    });
    const [group] = record.breakdown.models;
    expect(group!.cacheSavingMicros).toBeNull();
    // The frame's cost is still an estimate from its reported figure.
    expect(group!.basis).toBe("estimated");
  });

  it("voids the saving when an unpriced sibling call read the cache, even though another call priced", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [
        frame({ tokens: tokens({ input_uncached: 10, cache_read: 1000 }) }),
        // Before the book's first entry: nothing prices this call.
        frame({
          at: new Date("2025-06-01T00:00:00.000Z"),
          tokens: tokens({ cache_read: 1000 }),
          reportedCostMicros: null,
        }),
      ],
    });
    const [group] = record.breakdown.models;
    expect(group!.costMicros).not.toBeNull();
    expect(group!.hasUnpriced).toBe(true);
    expect(group!.cacheSavingMicros).toBeNull();
  });

  it("changes no figure the rollup already recorded, and names no entry that priced no tokens", () => {
    const p = priceFrame(
      BOOK,
      ORG,
      frame({ tokens: tokens({ cache_read: 1000, output: 10 }) }),
    );
    // input_uncached is resolved for the saving but priced nothing.
    expect(p.priceEntryIds.sort()).toEqual(["pe_cr", "pe_out"]);
    expect(p.scaled).toBe(1000n * 300_000n + 10n * 15_000_000n);
    expect(p.basis).toBe("gateway_observed");
    expect(p.cacheSavingScaled).toBe(1000n * 2_700_000n);
  });
});

describe("dailyTotalsFromRuns", () => {
  const base = rollupRun({
    meta,
    book: BOOK,
    toolCalls: [
      tool("Bash", { resultTokens: 400 }),
      tool("Bash"),
      tool("Read"),
    ],
    modelCalls: [frame(), frame({ basis: "client_attested" })],
  });
  const runs: RunTotalsRecord[] = [
    base,
    {
      ...rollupRun({
        meta: {
          ...meta,
          runId: "arun_2",
          runSource: "ledger",
          operatorPrincipalId: null,
          operatorKey: null,
          taskRef: "OXA-1",
          startedAt: new Date("2026-09-14T23:59:59.000Z"),
        },
        book: BOOK,
        toolCalls: [],
        modelCalls: [frame({ model: "mystery-9", reportedCostMicros: 100n })],
      }),
      verdict: "flipped",
      accepted: false,
    },
  ];

  it("folds runs into their day's operator, agent, task, model and tool groups", () => {
    const rows = dailyTotalsFromRuns(runs);
    const find = (kind: string, key: string) =>
      rows.find((r) => r.groupKind === kind && r.groupKey === key);

    const agent = find("agent", "acme.core.cc")!;
    expect(agent.day).toBe("2026-09-14");
    expect(agent.runs).toBe(2);
    expect(agent.calls).toBe(base.steps + 1);
    expect(agent.costMicros).toBe(9000n + 100n);
    expect(agent.costBasis).toBe("estimated");
    // Only the second run carries a verdict; its spend is proven.
    expect(agent.provenMicros).toBe(100n);
    expect(agent.acceptedMicros).toBe(0n);

    // An operator group's key is the principal's public id, the id list_runs
    // answers; the uuid stays off the wire. The second run names no operator:
    // nothing is attributed to that level for it.
    const operator = find("operator", meta.operatorKey!)!;
    expect(operator.runs).toBe(1);
    expect(operator.provenMicros).toBe(null);
    expect(find("operator", meta.operatorPrincipalId!)).toBeUndefined();
    expect(find("task", "OXA-1")!.runs).toBe(1);

    const sonnet = find("model", "claude-sonnet-5")!;
    expect(sonnet.calls).toBe(2);
    expect(sonnet.costMicros).toBe(9000n);
    expect(sonnet.costBasis).toBe("mixed");
    expect(sonnet.provider).toBe("anthropic");
    expect(find("model", "mystery-9")!.costBasis).toBe("estimated");
    // The workspace's model-neutral levels hold a guess, so they say so.
    expect(find("task", "OXA-1")!.costBasis).toBe("estimated");

    const bash = find("tool", "Bash")!;
    expect(bash.calls).toBe(2);
    expect(bash.runs).toBe(1);
    // The run row prices Bash's result tokens, but that figure is input the
    // model rows already count, so the tool group keeps no cost (ADR-199).
    expect(base.breakdown.tools.find((t) => t.name === "Bash")?.costMicros).toBe(
      1_200n,
    );
    expect(bash.costMicros).toBe(null);
    expect(bash.costBasis).toBe(null);
  });

  const ungraded: RunTotalsRecord = {
    ...base,
    advancedSteps: null,
    unproductiveSteps: null,
    productiveRatio: null,
  };

  it("weights a group's productive ratio by its graded steps, as the baseline does", () => {
    const graded = (steps: number, advanced: number): RunTotalsRecord => ({
      ...base,
      steps,
      advancedSteps: advanced,
      unproductiveSteps: steps - advanced,
      productiveRatio: advanced / steps,
    });
    const rows = dailyTotalsFromRuns([
      graded(10, 9),
      graded(2, 0),
      // An ungraded run adds nothing to the ratio or its weight.
      ungraded,
    ]);
    const agent = rows.find((r) => r.groupKind === "agent")!;
    // 9 of 12 steps advanced. The mean of the two runs' ratios would be 0.45.
    expect(agent.productiveRatio).toBeCloseTo(9 / 12, 12);
    expect(agent.gradedSteps).toBe(12);
  });

  it("leaves a group with no graded run without a ratio or a weight", () => {
    const rows = dailyTotalsFromRuns([ungraded]);
    const agent = rows.find((r) => r.groupKind === "agent")!;
    expect(agent.productiveRatio).toBeNull();
    expect(agent.gradedSteps).toBeNull();
  });

  it("keeps a group with no priced run at no cost", () => {
    const rows = dailyTotalsFromRuns([
      rollupRun({ meta, book: BOOK, toolCalls: [], modelCalls: [] }),
    ]);
    expect(rows.find((r) => r.groupKind === "agent")!.costMicros).toBe(null);
    expect(rows.some((r) => r.groupKind === "model")).toBe(false);
  });
});

describe("the cost-center level (ADR-142)", () => {
  // Three agents over two centers and one unlabelled agent, on one day.
  const at = (runId: string, agentKey: string, costCenter: string | null) =>
    rollupRun({
      meta: { ...meta, runId, agentKey, costCenter },
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
    });
  const runs = [
    at("tse_a1", "acme.core.alpha", "ENG-1001"),
    at("tse_a2", "acme.core.alpha", "ENG-1001"),
    at("tse_b1", "acme.core.beta", "MKT-2002"),
    at("tse_c1", "acme.core.gamma", null),
  ];

  it("puts every run in exactly one group, so the level sums to the run total", () => {
    const centers = dailyTotalsFromRuns(runs).filter(
      (r) => r.groupKind === "cost_center",
    );
    expect(centers.map((r) => [r.groupKey, r.runs]).sort()).toEqual([
      ["ENG-1001", 2],
      ["MKT-2002", 1],
      [UNASSIGNED_COST_CENTER_KEY, 1],
    ]);
    const levelTotal = centers.reduce((sum, r) => sum + r.costMicros!, 0n);
    const runTotal = runs.reduce((sum, r) => sum + r.costMicros!, 0n);
    expect(levelTotal).toBe(runTotal);
    expect(centers.every((r) => r.costBasis === "gateway_observed")).toBe(true);
  });

  it("keeps the unlabelled share as its own row instead of dropping it", () => {
    const none = dailyTotalsFromRuns(runs).find(
      (r) =>
        r.groupKind === "cost_center" &&
        r.groupKey === UNASSIGNED_COST_CENTER_KEY,
    )!;
    expect(none.costMicros).toBe(runs[3]!.costMicros);
  });
});

describe("proven spend by verdict (ADR-064)", () => {
  const priced = (runId: string, verdict: string | null): RunTotalsRecord => ({
    ...rollupRun({
      meta: { ...meta, runId },
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
    }),
    verdict,
  });

  it("credits a flipped run's spend and nothing of a tampered or failing one", () => {
    const agentRow = (runs: RunTotalsRecord[]) =>
      dailyTotalsFromRuns(runs).find(
        (r) => r.groupKind === "agent" && r.groupKey === "acme.core.cc",
      )!;
    const flipped = priced("tse_flipped", "flipped");
    expect(agentRow([flipped]).provenMicros).toBe(flipped.costMicros);
    // A verdict makes the proven figure exist; only `flipped` adds to it.
    expect(agentRow([priced("tse_tampered", "tampered")]).provenMicros).toBe(
      0n,
    );
    expect(agentRow([priced("tse_failing", "failing")]).provenMicros).toBe(0n);
    expect(agentRow([priced("tse_none", null)]).provenMicros).toBeNull();
  });
});
