import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import type { StoredRunTotals } from "../cost-rollup-store";
import { detectFindings, type DetectInput } from "./index";
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

function detect(runs: RunTotalsRecord[]) {
  const input: DetectInput = {
    window: { start: START, end: END },
    toolWindowStart: START,
    runs,
    toolCalls: [],
    decidedSince: new Map(),
  };
  return detectFindings(input).filter((f) => f.kind === "standing_context");
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

  it("names the split by source and leaves out a source no run reported", () => {
    const [finding] = detect([run()]);
    expect(finding!.why).toBe(
      "1 run re-sent 75,000 estimated tokens of standing context on every turn after the first: 60,000 of tool definitions and 15,000 of steering.",
    );
    const [all] = detect([run({ contextFrameTokens: 40_000 })]);
    expect(all!.why).toContain(
      "60,000 of tool definitions, 15,000 of steering, and 30,000 of context frames.",
    );
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
      "1 run re-sent 75,000 estimated tokens of standing context on every turn after the first: 60,000 of tool definitions and 15,000 of steering.",
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
