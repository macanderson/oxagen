import { describe, expect, it } from "vitest";
import {
  ZERO_TOKENS,
  type RunTotalsRecord,
  type TokenCounts,
} from "../cost-rollup";
import {
  detectInputFixture,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import {
  detectFindings,
  PAGE_TOKENS,
  type DetectReads,
  type FrameClassPrice,
  type FrameClassPrices,
  type PricedRequestFrame,
  type RunCompaction,
  type ToolCallObservation,
} from "./index";
import {
  CARRY_RESULT_TOKENS,
  carriesOf,
  frameReadPrice,
  inputContextOf,
} from "./unpaged-results";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = FIXTURE_WINDOW_START;
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const TOOL = "mcp__docs__search";
const MODEL = "claude-sonnet-5";
const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";

let seq = 0;

/**
 * A priced run. Input costs 3 micros a token (3,000 tokens for 9,000 micros).
 * `cacheRead` gives the run cache reads at their own cost, and `hasUnpriced`
 * marks a model call the rollup could not price. The detector prices a carry
 * from the carrying frame, so these figures matter only where no frame does.
 */
function run(
  over: Partial<RunTotalsRecord> & {
    cacheRead?: { tokens: number; micros: bigint };
    hasUnpriced?: boolean;
  } = {},
): RunTotalsRecord {
  seq += 1;
  const {
    cacheRead = { tokens: 0, micros: 0n },
    hasUnpriced = false,
    ...rest
  } = over;
  const tokens = {
    ...ZERO_TOKENS,
    input_uncached: 3_000,
    cache_read: cacheRead.tokens,
  };
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey: OPERATOR,
    agentPrincipalId: null,
    agentKey: AGENT,
    taskRef: null,
    costCenter: null,
    startedAt: new Date(START.getTime() + seq * 60_000),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 1,
    tokens,
    costMicros: 9_000n + cacheRead.micros,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: {
      models: [
        {
          model: MODEL,
          provider: "anthropic",
          calls: 1,
          tokens,
          costMicros: 9_000n + cacheRead.micros,
          costByClass: {
            input_uncached: 9_000n,
            cache_read: cacheRead.micros,
            cache_write_5m: 0n,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
            server_tool_request: 0n,
          },
          cacheSavingMicros: 0n,
          basis: "gateway_observed",
          hasUnpriced,
        },
      ],
      tools: [],
      steps: null,
    },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
    ...rest,
  };
}

/** A read-only call `at` seconds into the run that returned `resultTokens`. */
function call(
  r: RunTotalsRecord,
  at: number,
  resultTokens: number,
  over: Partial<ToolCallObservation> = {},
): ToolCallObservation {
  return {
    runId: r.runId,
    seq: at,
    tool: TOOL,
    inputDigest: `in-${at}`,
    outputDigest: `out-${at}`,
    isMutating: false,
    resultTokens,
    sessionUuid: null,
    ...over,
    at: new Date(r.startedAt.getTime() + at * 1_000),
  };
}

/** A list price entry of `microsPerMillion` for one class. */
function entry(
  tokenClass: keyof TokenCounts,
  microsPerMillion: bigint,
  currency = "USD",
): FrameClassPrice {
  return {
    entryId: `list:${MODEL}:${tokenClass}`,
    microsPerMillion,
    currency,
    source: "list",
  };
}

/** Uncached input at 3 micros a token, and cache reads at 0.3, a tenth of it. */
const PRICES: FrameClassPrices = {
  input_uncached: entry("input_uncached", 3_000_000n),
  cache_read: entry("cache_read", 300_000n),
  cache_write_5m: entry("cache_write_5m", 3_750_000n),
  cache_write_1h: entry("cache_write_1h", 6_000_000n),
  output: entry("output", 15_000_000n),
  reasoning: entry("reasoning", 15_000_000n),
  server_tool_request: null,
};

/** The book has no entry for the frame's model. */
const UNPRICED: FrameClassPrices = {
  input_uncached: null,
  cache_read: null,
  cache_write_5m: null,
  cache_write_1h: null,
  output: null,
  reasoning: null,
  server_tool_request: null,
};

interface FrameOver {
  /** The chain; left out for a frame that names no chain. */
  chain?: string | null;
  /** How many of the input context's tokens came from the cache. */
  cacheRead?: number;
  output?: number;
  /** The entries at the frame's instant; `UNPRICED` also leaves the frame with no cost. */
  prices?: FrameClassPrices;
  /** A frame literal with no class tokens or prices. */
  bare?: boolean;
}

/**
 * A model request `at` seconds into the run whose input context held
 * `context` tokens: uncached, less the `cacheRead` tokens it read from the
 * cache. Its total tokens add its output, as the findings store counts them.
 */
function frame(
  r: RunTotalsRecord,
  at: number,
  context: number,
  over: FrameOver = {},
): PricedRequestFrame {
  const time = new Date(r.startedAt.getTime() + at * 1_000);
  const cacheRead = over.cacheRead ?? 0;
  const output = over.output ?? 0;
  const prices = over.prices ?? PRICES;
  const unpriced = prices === UNPRICED;
  const base: PricedRequestFrame = {
    key: `${time.toISOString()}#0`,
    at: time,
    costMicros: unpriced ? null : 12_000n,
    tokens: context + output,
    basis: unpriced ? null : "gateway_observed",
    ...(over.chain === undefined ? {} : { sessionUuid: over.chain }),
  };
  if (over.bare === true) return base;
  const classTokens: TokenCounts = {
    ...ZERO_TOKENS,
    input_uncached: context - cacheRead,
    cache_read: cacheRead,
    output,
  };
  return {
    ...base,
    model: MODEL,
    provider: "anthropic",
    classTokens,
    classPrices: prices,
  };
}

/** A compaction `at` whole seconds into the run, on the run's own chain unless `chain` names one. */
function compaction(
  r: RunTotalsRecord,
  at: number,
  chain: string | null = null,
): RunCompaction {
  const time = new Date(r.startedAt.getTime() + at * 1_000);
  return {
    at: time,
    atMicros: time.getTime() * 1_000,
    seq: at,
    sessionUuid: chain,
    trigger: "auto",
    tokensBefore: null,
    tokensAfter: null,
  };
}

function detect(over: Partial<DetectReads>) {
  return detectFindings(detectInputFixture(over));
}

describe("context carry", () => {
  it("prices a 6,000-token result once for each of the three requests that carry it before a compaction", () => {
    const r = run();
    const [finding, ...rest] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([
        [
          r.runId,
          [
            // The request that made the call, then three that carry the
            // result, then the compaction's own request and one after it.
            frame(r, 0.5, 40_000),
            frame(r, 2, 47_000),
            frame(r, 3, 48_000),
            frame(r, 4, 49_000),
            frame(r, 5, 50_000),
            frame(r, 6, 12_000),
          ],
        ],
      ]),
      compactions: new Map([[r.runId, [compaction(r, 5)]]]),
    });
    expect(rest).toEqual([]);
    // Each carry saves the 2,000 tokens past a 4,000-token page.
    expect(finding).toMatchObject({
      kind: "unpaged_results",
      level: "tool",
      subject: TOOL,
      savingMicros: 3n * BigInt(6_000 - PAGE_TOKENS) * 3n,
      confidence: "high",
    });
    expect(finding!.evidence).toMatchObject({
      calls: 3,
      coveredCalls: 3,
      measuredTokens: 18_000,
      counterfactualTokens: 3 * PAGE_TOKENS,
    });
    expect(finding!.evidence.frames).toEqual({
      [r.runId]: { seqs: [{ seq: "1" }], total: 1 },
    });
    expect(finding!.claims).toBeUndefined();
    expect(finding!.why).toBe(
      `${TOOL} returned 1 result over 5,000 tokens on 1 run. Later requests read it 3 times.`,
    );
  });

  it("ends the carry where the input context drops by the result's size when the run has no compaction record", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000),
            frame(r, 2, 47_000),
            frame(r, 3, 48_000),
            frame(r, 4, 49_000),
            frame(r, 5, 12_000),
            frame(r, 6, 13_000),
          ],
        ],
      ]),
    });
    expect(finding!.evidence.calls).toBe(3);
  });

  it("prices none for a 4,000-token result or one of exactly 5,000 tokens", () => {
    const r = run();
    const frames = [0.5, 2, 3, 4, 5].map((at) => frame(r, at, 40_000));
    for (const tokens of [4_000, CARRY_RESULT_TOKENS])
      expect(
        detect({
          runs: [r],
          toolCalls: [call(r, 1, tokens)],
          frames: new Map([[r.runId, frames]]),
        }),
      ).toEqual([]);
  });

  it("writes nothing when the tokens past the page cost under a cent", () => {
    // One request carries the result: 2,000 tokens past the page at 3 micros
    // each is 6,000 micros, under MIN_SAVING_MICROS.
    const r = run();
    expect(
      detect({
        runs: [r],
        toolCalls: [call(r, 1, 6_000)],
        frames: new Map([
          [r.runId, [frame(r, 0.5, 40_000), frame(r, 2, 47_000)]],
        ]),
      }),
    ).toEqual([]);
  });

  it("keeps carrying through a drop smaller than the result, and to the end of the run", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000),
            frame(r, 2, 47_000),
            frame(r, 3, 43_000),
            frame(r, 4, 44_000),
          ],
        ],
      ]),
    });
    expect(finding!.evidence.calls).toBe(3);
  });

  it("counts two results of one tool in one finding, each with its own carry", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000), call(r, 3, 8_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000),
            frame(r, 2, 47_000),
            frame(r, 4, 56_000),
            frame(r, 5, 57_000),
          ],
        ],
      ]),
    });
    // The first result rides three requests, and the second rides two.
    expect(finding!.evidence).toMatchObject({
      calls: 5,
      measuredTokens: 6_000 * 3 + 8_000 * 2,
      counterfactualTokens: 5 * PAGE_TOKENS,
    });
    expect(finding!.evidence.frames?.[r.runId]?.total).toBe(2);
    expect(finding!.why).toBe(
      `${TOOL} returned 2 results over 5,000 tokens on 1 run. Later requests read them 5 times.`,
    );
  });

  it("prices nothing when no later request on the call's chain carried the result", () => {
    const r = run();
    expect(
      detect({
        runs: [r],
        toolCalls: [call(r, 1, 30_000)],
        frames: new Map([[r.runId, [frame(r, 0.5, 40_000)]]]),
      }),
    ).toEqual([]);
  });

  it("counts only the call's own chain", () => {
    // One carry of a 10,000-token result saves 6,000 tokens past the page,
    // which clears MIN_SAVING_MICROS.
    const r = run();
    const [rootFinding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 10_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000, { chain: null }),
            frame(r, 2, 9_000, { chain: SUBAGENT }),
            frame(r, 3, 16_000, { chain: SUBAGENT }),
            frame(r, 4, 51_000, { chain: null }),
          ],
        ],
      ]),
    });
    expect(rootFinding!.evidence.calls).toBe(1);

    const s = run();
    const [subagentFinding] = detect({
      runs: [s],
      toolCalls: [call(s, 1, 10_000, { sessionUuid: SUBAGENT })],
      frames: new Map([
        [
          s.runId,
          [
            frame(s, 0.5, 9_000, { chain: SUBAGENT }),
            frame(s, 2, 40_000, { chain: null }),
            frame(s, 3, 20_000, { chain: SUBAGENT }),
            frame(s, 4, 47_000, { chain: null }),
          ],
        ],
      ]),
    });
    expect(subagentFinding!.evidence.calls).toBe(1);
  });

  it("ends a carry at a compaction on the call's own chain and not at one on another chain", () => {
    const r = run();
    const frames = [
      frame(r, 0.5, 40_000),
      frame(r, 2, 47_000),
      frame(r, 3, 48_000),
      frame(r, 4, 49_000),
      frame(r, 5, 50_000),
    ];
    const [root] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([[r.runId, frames]]),
      // A subagent's compaction sheds the subagent's context alone.
      compactions: new Map([[r.runId, [compaction(r, 3, SUBAGENT)]]]),
    });
    expect(root!.evidence.calls).toBe(4);

    const [own] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([[r.runId, frames]]),
      compactions: new Map([
        [r.runId, [compaction(r, 3, SUBAGENT), compaction(r, 4)]],
      ]),
    });
    expect(own!.evidence.calls).toBe(2);
  });

  it("prices a result over 20,000 tokens once against a page when the call's chain has no frames", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 25_000, { sessionUuid: SUBAGENT })],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000, { chain: null }),
            frame(r, 2, 66_000, { chain: null }),
          ],
        ],
      ]),
    });
    expect(finding).toMatchObject({
      kind: "unpaged_results",
      savingMicros: BigInt((25_000 - PAGE_TOKENS) * 3),
    });
    expect(finding!.evidence).toMatchObject({
      calls: 1,
      measuredTokens: 25_000,
      counterfactualTokens: PAGE_TOKENS,
    });
  });

  it("prices none for a 6,000-token result on a run whose frames were not read", () => {
    const r = run();
    expect(detect({ runs: [r], toolCalls: [call(r, 1, 6_000)] })).toEqual([]);
  });

  it("prices each carry and its page at the carrying request's cache read price", () => {
    // Cache reads cost 0.3 micros a token here, a tenth of uncached input. A
    // carry of 15,000 tokens costs 4,500 micros, and its page costs 1,200.
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 15_000)],
      frames: new Map([
        [
          r.runId,
          [0.5, 2, 3, 4, 5].map((at, i) =>
            frame(r, at, 40_000 + i * 16_000, {
              cacheRead: 39_000 + i * 16_000,
            }),
          ),
        ],
      ]),
    });
    expect(finding!.evidence.calls).toBe(4);
    expect(finding!.savingMicros).toBe(4n * (4_500n - 1_200n));
  });

  it("prices each carry at the price in force at its own request", () => {
    // The cache read price doubles to 0.6 micros a token between the two
    // carries. 26,000 tokens past the page cost 7,800 micros at the first
    // price and 15,600 at the second.
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 30_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 100_000, { cacheRead: 99_000 }),
            frame(r, 2, 131_000, { cacheRead: 100_000 }),
            frame(r, 3, 132_000, {
              cacheRead: 131_000,
              prices: { ...PRICES, cache_read: entry("cache_read", 600_000n) },
            }),
          ],
        ],
      ]),
    });
    expect(finding!.savingMicros).toBe(7_800n + 15_600n);
  });

  // #4544, https://github.com/macanderson/oxagen/pull/4536#discussion_r4116248066
  it("prices a partly priced run's carries at the priced requests' rate and leaves the unpriced one uncovered", () => {
    // The run read 1,000,000 priced and 1,000,000 unpriced cache tokens, so
    // its cache read cost over its cache read tokens is 0.15 micros a token,
    // half the real 0.3. The carries take each request's own price instead.
    const r = run({
      cacheRead: { tokens: 2_000_000, micros: 300_000n },
      hasUnpriced: true,
    });
    const [finding, ...rest] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 30_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 100_000, { cacheRead: 99_000 }),
            frame(r, 2, 131_000, { cacheRead: 100_000 }),
            frame(r, 3, 132_000, { cacheRead: 131_000 }),
            frame(r, 4, 133_000, { cacheRead: 132_000, prices: UNPRICED }),
          ],
        ],
      ]),
    });
    expect(rest).toEqual([]);
    // Two priced carries of 26,000 tokens past the page at 0.3 micros.
    expect(finding).toMatchObject({
      savingMicros: 2n * 7_800n,
      confidence: "medium",
      basis: "gateway_observed",
    });
    expect(finding!.evidence).toMatchObject({ calls: 3, coveredCalls: 2 });
  });

  // #4544, https://github.com/macanderson/oxagen/pull/4536#discussion_r4116248066
  it("leaves a partly priced run's result uncovered when the call's chain has no frames", () => {
    const r = run({ hasUnpriced: true });
    expect(
      detect({
        runs: [r],
        toolCalls: [call(r, 1, 25_000, { sessionUuid: SUBAGENT })],
        frames: new Map([
          [
            r.runId,
            [
              frame(r, 0.5, 40_000, { chain: null }),
              frame(r, 2, 66_000, { chain: null }),
            ],
          ],
        ]),
      }),
    ).toEqual([]);
  });

  // #4544, https://github.com/macanderson/oxagen/pull/4536#discussion_r4116188323
  it("counts a carry when a request's total tokens fall and its input context grows", () => {
    // The request before the result sends 40,000 tokens and writes 15,000.
    // The next sends 46,000, 6,000 of them the result, and writes 1,000. Its
    // total falls by 8,000, more than the result, yet its context grew.
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 6_000)],
      frames: new Map([
        [
          r.runId,
          [
            frame(r, 0.5, 40_000, { output: 15_000 }),
            frame(r, 2, 46_000, { output: 1_000 }),
            frame(r, 3, 47_000, { output: 1_000 }),
            frame(r, 4, 48_000, { output: 1_000 }),
          ],
        ],
      ]),
    });
    expect(finding!.evidence.calls).toBe(3);
  });
});

describe("frameReadPrice", () => {
  const r = run();

  it("is the cache read entry for a request that read the cache", () => {
    expect(
      frameReadPrice(frame(r, 2, 50_000, { cacheRead: 40_000 }), "USD"),
    ).toEqual({ micros: 300_000n, tokens: 1_000_000n });
  });

  it("is the uncached input entry for a request that read no cache", () => {
    expect(frameReadPrice(frame(r, 2, 50_000), "USD")).toEqual({
      micros: 3_000_000n,
      tokens: 1_000_000n,
    });
  });

  it("is null when a request read the cache and the book has no cache read entry", () => {
    expect(
      frameReadPrice(
        frame(r, 2, 50_000, {
          cacheRead: 40_000,
          prices: { ...PRICES, cache_read: null },
        }),
        "USD",
      ),
    ).toBeNull();
  });

  it("is null for a frame with no class prices, and for an entry in another currency", () => {
    expect(frameReadPrice(frame(r, 2, 50_000, { bare: true }), "USD")).toBeNull();
    expect(
      frameReadPrice(
        frame(r, 2, 50_000, {
          prices: {
            ...PRICES,
            input_uncached: entry("input_uncached", 3_000_000n, "EUR"),
          },
        }),
        "USD",
      ),
    ).toBeNull();
  });
});

describe("inputContextOf", () => {
  const r = run();

  it("counts uncached input, cache reads, and cache writes, and leaves out output", () => {
    const f = frame(r, 2, 50_000, { cacheRead: 40_000, output: 9_000 });
    f.classTokens!.cache_write_5m = 1_000;
    f.classTokens!.cache_write_1h = 500;
    f.classTokens!.reasoning = 2_000;
    expect(inputContextOf(f)).toBe(51_500);
  });

  it("is null for a frame with no class tokens", () => {
    expect(inputContextOf(frame(r, 2, 50_000, { bare: true }))).toBeNull();
  });
});

describe("carriesOf", () => {
  const r = run();
  const at = (s: number) => (r.startedAt.getTime() + s * 1_000) * 1_000;

  it("takes the frames after the call, not the one that made it", () => {
    const chain = [frame(r, 0.5, 40_000), frame(r, 2, 47_000)];
    expect(carriesOf(chain, at(1), 6_000)).toEqual([chain[1]]);
  });

  it("ends at a drop of exactly the result's size", () => {
    const chain = [
      frame(r, 0.5, 40_000),
      frame(r, 2, 47_000),
      frame(r, 3, 41_000),
      frame(r, 4, 42_000),
    ];
    expect(carriesOf(chain, at(1), 6_000)).toEqual([chain[1]]);
  });

  it("ends at a drop right after the call", () => {
    const chain = [frame(r, 0.5, 40_000), frame(r, 2, 10_000)];
    expect(carriesOf(chain, at(1), 6_000)).toEqual([]);
  });

  it("counts from the first frame when none came before the call", () => {
    const chain = [frame(r, 2, 47_000), frame(r, 3, 48_000)];
    expect(carriesOf(chain, at(1), 6_000)).toEqual(chain);
  });

  // #4544, https://github.com/macanderson/oxagen/pull/4536#discussion_r4116188323
  it("compares input context, not total tokens", () => {
    const chain = [
      frame(r, 0.5, 40_000, { output: 15_000 }),
      frame(r, 2, 46_000, { output: 1_000 }),
    ];
    expect(carriesOf(chain, at(1), 6_000)).toEqual([chain[1]]);
  });

  it("ends before the first compaction after the call, and a frame at the compaction's instant does not carry", () => {
    const chain = [
      frame(r, 0.5, 40_000),
      frame(r, 2, 47_000),
      frame(r, 3, 48_000),
      frame(r, 4, 49_000),
    ];
    expect(carriesOf(chain, at(1), 6_000, [compaction(r, 3)])).toEqual([
      chain[1],
    ]);
  });

  it("keeps carrying past a compaction before the call", () => {
    const chain = [
      frame(r, 0.5, 40_000),
      frame(r, 2, 47_000),
      frame(r, 3, 48_000),
    ];
    expect(carriesOf(chain, at(1), 6_000, [compaction(r, 0)])).toEqual([
      chain[1],
      chain[2],
    ]);
  });

  // #4585, https://github.com/macanderson/oxagen/pull/4585#discussion_r4116779690
  it("orders a compaction at the call's instant by seq", () => {
    const chain = [frame(r, 0.5, 40_000), frame(r, 2, 47_000)];
    const tied = (seq: number) => ({ ...compaction(r, 1), seq });
    expect(carriesOf(chain, at(1), 6_000, [tied(8)], 5)).toEqual([]);
    expect(carriesOf(chain, at(1), 6_000, [tied(3)], 5)).toEqual([chain[1]]);
  });

  it("never ends the carry at a frame with no class tokens", () => {
    const chain = [
      frame(r, 0.5, 40_000, { bare: true }),
      frame(r, 2, 10_000, { bare: true }),
    ];
    expect(carriesOf(chain, at(1), 6_000)).toEqual([chain[1]]);
  });
});
