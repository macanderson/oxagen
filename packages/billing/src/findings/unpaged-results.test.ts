import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import {
  detectFindings,
  PAGE_TOKENS,
  type DetectInput,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./index";
import { standingReadPrice } from "../standing-context-price";
import { CARRY_RESULT_TOKENS, carriesOf } from "./unpaged-results";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const TOOL = "mcp__docs__search";
const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";

let seq = 0;

/**
 * A priced run. Input costs 3 micros a token (3,000 tokens for 9,000 micros)
 * and the run read no cache, so a re-read token also costs 3 micros.
 * `cacheRead` gives the run cache reads at their own price.
 */
function run(
  over: Partial<RunTotalsRecord> & {
    cacheRead?: { tokens: number; micros: bigint };
  } = {},
): RunTotalsRecord {
  seq += 1;
  const { cacheRead = { tokens: 0, micros: 0n }, ...rest } = over;
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
          model: "claude-sonnet-5",
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
          hasUnpriced: false,
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

/**
 * A model request `at` seconds into the run whose context held `tokens`.
 * `chain` is left out for a frame that names no chain.
 */
function frame(
  r: RunTotalsRecord,
  at: number,
  tokens: number,
  chain?: string | null,
): PricedRequestFrame {
  const time = new Date(r.startedAt.getTime() + at * 1_000);
  return {
    key: `${time.toISOString()}#0`,
    at: time,
    costMicros: 12_000n,
    tokens,
    basis: "gateway_observed",
    ...(chain === undefined ? {} : { sessionUuid: chain }),
  };
}

function detect(over: Partial<DetectInput>) {
  return detectFindings({
    window: { start: START, end: END },
    toolWindowStart: START,
    runs: [],
    toolCalls: [],
    decidedSince: new Map(),
    ...over,
  });
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
            // result, then a compaction and one request after it.
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
            frame(r, 0.5, 40_000, null),
            frame(r, 2, 9_000, SUBAGENT),
            frame(r, 3, 16_000, SUBAGENT),
            frame(r, 4, 51_000, null),
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
            frame(s, 0.5, 9_000, SUBAGENT),
            frame(s, 2, 40_000, null),
            frame(s, 3, 20_000, SUBAGENT),
            frame(s, 4, 47_000, null),
          ],
        ],
      ]),
    });
    expect(subagentFinding!.evidence.calls).toBe(1);
  });

  it("prices a result over 20,000 tokens once against a page when the call's chain has no frames", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 25_000, { sessionUuid: SUBAGENT })],
      frames: new Map([
        [r.runId, [frame(r, 0.5, 40_000, null), frame(r, 2, 66_000, null)]],
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

  it("prices each carry and its page at the run's cache read price", () => {
    // Cache reads cost 0.3 micros a token here, a tenth of uncached input. A
    // carry of 15,000 tokens costs 4,500 micros, and its page costs 1,200.
    const r = run({ cacheRead: { tokens: 100_000, micros: 30_000n } });
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, 1, 15_000)],
      frames: new Map([
        [
          r.runId,
          [0.5, 2, 3, 4, 5].map((at, i) => frame(r, at, 40_000 + i * 16_000)),
        ],
      ]),
    });
    expect(finding!.evidence.calls).toBe(4);
    expect(finding!.savingMicros).toBe(4n * (4_500n - 1_200n));
  });
});

describe("the read price a carry is priced at", () => {
  it("is the run's cache reads over their tokens", () => {
    expect(
      standingReadPrice(
        run({ cacheRead: { tokens: 100_000, micros: 30_000n } }),
      ),
    ).toEqual({ micros: 30_000n, tokens: 100_000n });
  });

  it("is the uncached input price for a run that read no cache", () => {
    expect(standingReadPrice(run())).toEqual({
      micros: 9_000n,
      tokens: 3_000n,
    });
  });

  it("is zero, not unknown, for cache reads the book priced at nothing", () => {
    expect(
      standingReadPrice(run({ cacheRead: { tokens: 100_000, micros: 0n } })),
    ).toEqual({ micros: 0n, tokens: 100_000n });
  });

  it("is null when a cache read went unpriced, or the run is estimated or unpriced", () => {
    const partial = run({ cacheRead: { tokens: 100_000, micros: 30_000n } });
    partial.breakdown.models[0]!.hasUnpriced = true;
    expect(standingReadPrice(partial)).toBeNull();
    expect(standingReadPrice(run({ costBasis: "estimated" }))).toBeNull();
    expect(
      standingReadPrice(run({ costBasis: null, costMicros: null })),
    ).toBeNull();
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
});
