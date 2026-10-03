import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import {
  createStandingSplit,
  type StoredRunTotals,
} from "../cost-rollup-store";
import {
  detectFindings,
  type DetectInput,
  type FrameContextPart,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./index";
import { standingSourcesOf as sourcesOf } from "../standing-context-price";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";

let seq = 0;

/**
 * A priced run of four model calls. Input costs 3 micros a token, and a cache
 * read costs 0.3 micros a token (30,000 tokens for 9,000 micros).
 */
function run(
  over: Partial<StoredRunTotals> & { cacheRead?: number } = {},
): StoredRunTotals {
  seq += 1;
  const { cacheRead = 30_000, ...rest } = over;
  const tokens = {
    ...ZERO_TOKENS,
    input_uncached: 3_000,
    cache_read: cacheRead,
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
    turns: 4,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 4,
    modelCalls: 4,
    toolCalls: 0,
    tokens,
    costMicros: 18_000n,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 4,
          tokens,
          costMicros: 18_000n,
          costByClass: {
            input_uncached: 9_000n,
            cache_read: cacheRead === 0 ? 0n : 9_000n,
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
    // Sums over the four calls: 20,000 and 5,000 tokens on each.
    toolDefinitionTokens: 80_000,
    contextFrameTokens: null,
    steeringTokens: 20_000,
    ...rest,
  };
}

function detect(runs: RunTotalsRecord[], over: Partial<DetectInput> = {}) {
  const input: DetectInput = {
    window: { start: START, end: END },
    toolWindowStart: START,
    runs,
    toolCalls: [],
    decidedSince: new Map(),
    ...over,
  };
  return detectFindings(input).filter((f) => f.kind === "standing_context");
}

/** A tool definition in a request's system context, as the recorder lists it. */
function tool(name: string, provider: string, tokens: number): FrameContextPart {
  return { kind: "tool", name, provider, digest: `sha256:${name}`, tokens };
}

/** One model call of a run whose system context lists `parts`. */
function frameListing(
  r: RunTotalsRecord,
  minute: number,
  parts: readonly FrameContextPart[],
): PricedRequestFrame {
  const at = new Date(r.startedAt.getTime() + minute * 60_000);
  return {
    key: `${at.toISOString()}#0`,
    at,
    costMicros: 4_500n,
    tokens: 25_000,
    basis: "gateway_observed",
    systemContextDigest: "sha256:context",
    systemContextParts: parts,
  };
}

/** A call the run made to `name`. */
function callTo(r: RunTotalsRecord, name: string): ToolCallObservation {
  return {
    runId: r.runId,
    at: new Date(r.startedAt.getTime() + 30_000),
    seq: 3,
    tool: name,
    inputDigest: "in-1",
    outputDigest: "out-1",
    isMutating: false,
    resultTokens: 200,
    sessionUuid: null,
  };
}

describe("standing context", () => {
  it("prices the prefix every call after the first re-sent, at the run's cache read price", () => {
    const r = run();
    const [finding, ...rest] = detect([r]);
    expect(rest).toEqual([]);
    // 100,000 tokens over four calls: three calls re-sent 75,000 of them,
    // at 0.3 micros a token.
    expect(finding).toMatchObject({
      kind: "standing_context",
      level: "agent",
      subject: AGENT,
      savingMicros: 22_500n,
      basis: "estimated",
      citedRuns: [r.runId],
    });
    expect(finding!.evidence).toMatchObject({
      measuredTokens: 75_000,
      counterfactualTokens: 0,
      measuredMicros: "22500",
      counterfactualMicros: "0",
    });
    // It prices a part of each request, so it claims no frame.
    expect(finding!.claims).toBeUndefined();
    expect(finding!.evidence.frames).toBeUndefined();
  });

  // #4572 item 9: the text said "every turn after the first", and one turn
  // can hold several model calls. The finding prices model calls.
  it("names the split by source, in model calls, and leaves out a source no run reported", () => {
    const [finding] = detect([run()]);
    expect(finding!.why).toBe(
      "1 run re-sent 75,000 estimated tokens of standing context on every model call after the first: 60,000 of tool definitions and 15,000 of steering.",
    );
    expect(finding!.why).not.toContain("turn");
    const [all] = detect([run({ contextFrameTokens: 40_000 })]);
    expect(all!.why).toContain(
      "60,000 of tool definitions, 15,000 of steering, and 30,000 of context frames.",
    );
  });

  // #4572 item 6: the old counterfactual was 0, so the saving counted the
  // context frames' 9,000 micros too (31,500 in all), and the fix cannot
  // reach them.
  it("counts the context frames in the measure and leaves them out of the saving", () => {
    const [finding] = detect([run({ contextFrameTokens: 40_000 })]);
    // 140,000 tokens over four calls: three re-sent 105,000, and 30,000 of
    // those are context frames, at 0.3 micros a token.
    expect(finding!.evidence).toMatchObject({
      measuredTokens: 105_000,
      counterfactualTokens: 30_000,
      measuredMicros: "31500",
      counterfactualMicros: "9000",
    });
    expect(finding!.savingMicros).toBe(22_500n);
    expect(finding!.why).toContain(
      "The saving leaves out the context frames, which the fix does not change.",
    );
  });

  // #5339. The rollup's split counts a growing source as re-sent only as far
  // as an earlier call carried it, and the finding prices that split. Four
  // calls carried 20,000 tool definition tokens and 5,000 of steering each,
  // and context that grew from none to 4,000 to 6,000: the context's first
  // sends, 4,000 and 2,000, are not re-sent.
  it("prices the rollup's re-sent split, which leaves a growing source's first sends out", () => {
    const r = run({ contextFrameTokens: 16_000 });
    const split = createStandingSplit();
    for (const [minute, context] of [
      [1, null],
      [2, 4_000],
      [3, 6_000],
      [4, 6_000],
    ] as const)
      split.add({
        at: new Date(START.getTime() + minute * 1_000),
        model: "claude-sonnet-5",
        provider: "anthropic",
        tokens: { ...ZERO_TOKENS, input_uncached: 750, cache_read: 7_500 },
        reportedCostMicros: null,
        basis: "gateway_observed",
        sources: {
          toolDefinitionTokens: 20_000,
          contextFrameTokens: context,
          steeringTokens: 5_000,
        },
      });
    r.breakdown.standing = split.finish();
    const [finding] = detect([r]);
    // 60,000 of tool definitions, 15,000 of steering, and 4,000 then 6,000
    // of context frames, at 0.3 micros a token. Every call before #5339 would
    // have counted 16,000 of context frames.
    expect(finding!.evidence).toMatchObject({
      measuredTokens: 85_000,
      counterfactualTokens: 10_000,
      measuredMicros: "25500",
      counterfactualMicros: "3000",
    });
    expect(finding!.evidence.values).toMatchObject({
      contextFrameTokens: 10_000,
    });
  });

  it("writes nothing for a run whose only re-sent source is context frames", () => {
    expect(
      detect([
        run({
          toolDefinitionTokens: null,
          steeringTokens: null,
          contextFrameTokens: 40_000,
        }),
      ]),
    ).toEqual([]);
  });

  it("prices at the input price when the run read nothing from the cache", () => {
    const [finding] = detect([run({ cacheRead: 0 })]);
    expect(finding!.savingMicros).toBe(225_000n);
  });

  it("splits only the runs it priced, so the parts add up to the total", () => {
    const [finding] = detect([run(), run({ costBasis: "estimated" })]);
    expect(finding!.evidence).toMatchObject({
      calls: 2,
      coveredCalls: 1,
      measuredTokens: 75_000,
    });
    expect(finding!.why).toBe(
      "1 run re-sent 75,000 estimated tokens of standing context on every model call after the first: 60,000 of tool definitions and 15,000 of steering.",
    );
  });

  it("writes nothing when the cache reads were free, and never prices them at the input rate", () => {
    const free = run();
    free.breakdown.models[0]!.costByClass.cache_read = 0n;
    expect(detect([free])).toEqual([]);
  });

  it("writes nothing when a cache read went unpriced, rather than pricing the reads as input", () => {
    const partial = run();
    partial.breakdown.models[0]!.hasUnpriced = true;
    expect(detect([partial])).toEqual([]);
  });

  // #5023: the card names the provider whose definitions add the most
  // tokens to a request, and the weekly price the tool and steering pages
  // quote, so a provider of the same size shows the same price everywhere.
  it("stores the top tool provider, the tools the runs called, and the week's price per 1,000 tokens", () => {
    const r = run();
    const parts = [
      // The harness's own tools cannot move to Searchable, so they are left out.
      tool("Read", "builtin", 9_000),
      tool("mcp__github__get_pr", "github", 3_000),
      tool("mcp__github__list_issues", "github", 2_000),
      tool("mcp__slack__post", "slack", 4_000),
      { kind: "steering", name: "ctx.rules", digest: "sha256:r", tokens: 5_000 },
    ] satisfies FrameContextPart[];
    const [finding] = detect([r], {
      frames: new Map([
        [r.runId, [frameListing(r, 0, parts), frameListing(r, 1, parts)]],
      ]),
      toolCalls: [
        callTo(r, "mcp__github__get_pr"),
        callTo(r, "mcp__github__get_pr"),
      ],
      weeklyContextPrice: { perThousandMicros: 29_110_000n, currency: "USD" },
    });
    expect(finding!.evidence.values).toEqual({
      kind: "standing_context",
      resentTokens: 75_000,
      toolDefinitionTokens: 60_000,
      steeringTokens: 15_000,
      contextFrameTokens: null,
      provider: {
        name: "github",
        tokens: 5_000,
        tools: 2,
        toolsCalled: 1,
        // 5,000 tokens at $29.11 a week for each 1,000.
        weeklyPrice: {
          micros: "145550000",
          currency: "USD",
          basis: "estimated",
        },
      },
      weeklyPricePerThousand: {
        micros: "29110000",
        currency: "USD",
        basis: "estimated",
      },
    });
  });

  it("stores no provider and no price, never zeros, when no frame listed one and the week had no price (negative)", () => {
    const r = run();
    const [finding] = detect([r], { weeklyContextPrice: null });
    expect(finding!.evidence.values).toMatchObject({
      kind: "standing_context",
      resentTokens: 75_000,
      provider: null,
      weeklyPricePerThousand: null,
    });
    // A pass that read no price at all stores none either.
    const [unread] = detect([run()]);
    expect(unread!.evidence.values).toMatchObject({
      provider: null,
      weeklyPricePerThousand: null,
    });
  });

  it("cites the operator when the run names no agent", () => {
    const [finding] = detect([run({ agentKey: null })]);
    expect(finding).toMatchObject({ level: "operator", subject: OPERATOR });
  });

  it("writes nothing for a run of one call, a run with no reported source, or an estimated run", () => {
    expect(
      detect([
        run({ modelCalls: 1 }),
        run({ toolDefinitionTokens: null, steeringTokens: null }),
        run({ costBasis: "estimated" }),
      ]),
    ).toEqual([]);
  });

  it("reads a record that carries no source columns as unreported", () => {
    const { toolDefinitionTokens, contextFrameTokens, steeringTokens, ...bare } =
      run();
    void toolDefinitionTokens;
    void contextFrameTokens;
    void steeringTokens;
    expect(sourcesOf(bare)).toEqual({
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    });
    expect(detect([bare])).toEqual([]);
  });
});
