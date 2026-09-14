import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  dailyTotalsFromRuns,
  divideHalfEven,
  microsToCentsHalfEven,
  priceFrame,
  rollupRun,
  type ModelCallFrame,
  type RunMeta,
  type RunTotalsRecord,
  type TokenCounts,
  ZERO_TOKENS,
} from "./cost-rollup";
import type { PriceEntry } from "./price-book";

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
  operatorPrincipalId: "pr-op",
  agentPrincipalId: "pr-agent",
  agentKey: "acme.core.cc",
  taskRef: null,
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

  it("answers no cost and no basis for a run with no model frame, never a zero", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [{ name: "Bash" }, { name: null }],
      modelCalls: [],
    });
    expect(record.costMicros).toBe(null);
    expect(record.costBasis).toBe(null);
    expect(record.cacheHitRate).toBe(null);
    expect(record.toolCalls).toBe(2);
    expect(record.breakdown.tools).toEqual([{ name: "Bash", calls: 1 }]);
    expect(record.breakdown.models).toEqual([]);
  });

  it("carries the proof and value columns another lane wrote", () => {
    const record = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
      carried: { verdict: "flipped", accepted: null, productiveRatio: 0.5 },
    });
    expect(record.verdict).toBe("flipped");
    expect(record.productiveRatio).toBe(0.5);
    const fresh = rollupRun({
      meta,
      book: BOOK,
      toolCalls: [],
      modelCalls: [frame()],
    });
    expect(fresh.verdict).toBe(null);
  });
});

describe("dailyTotalsFromRuns", () => {
  const base = rollupRun({
    meta,
    book: BOOK,
    toolCalls: [{ name: "Bash" }, { name: "Bash" }, { name: "Read" }],
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

    // The second run names no operator: nothing is attributed to that level for it.
    expect(find("operator", "pr-op")!.runs).toBe(1);
    expect(find("operator", "pr-op")!.provenMicros).toBe(null);
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
    expect(bash.costMicros).toBe(null);
    expect(bash.costBasis).toBe(null);
  });

  it("keeps a group with no priced run at no cost", () => {
    const rows = dailyTotalsFromRuns([
      rollupRun({ meta, book: BOOK, toolCalls: [], modelCalls: [] }),
    ]);
    expect(rows.find((r) => r.groupKind === "agent")!.costMicros).toBe(null);
    expect(rows.some((r) => r.groupKind === "model")).toBe(false);
  });
});
