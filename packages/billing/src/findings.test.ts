import { FINDING_KINDS } from "@oxagen/database/schema";
import { FINDINGS_LIST_MAX } from "@oxagen/oxagen/contracts/finding.list";
import { findingEvidenceSchema } from "@oxagen/oxagen/contracts/finding.shared";
import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import {
  detectFindings,
  EVIDENCE_RUNS,
  FINDINGS_PER_KIND,
  findingFingerprint,
  MIN_SAVING_MICROS,
  PAGE_TOKENS,
  runInputPrice,
  UNPAGED_RESULT_TOKENS,
  type DetectInput,
  type ToolCallObservation,
} from "./findings";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";

let seq = 0;

/**
 * A priced run. Input costs 3 micros a token (3,000 tokens for 9,000 micros),
 * so a token re-priced at the run's input price is 3 micros.
 */
function run(
  over: Partial<RunTotalsRecord> & { cacheWriteMicros?: bigint } = {},
): RunTotalsRecord {
  seq += 1;
  const { cacheWriteMicros = 0n, ...rest } = over;
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
    tokens: { ...ZERO_TOKENS, input_uncached: 3_000 },
    costMicros: 9_000n + cacheWriteMicros,
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
          tokens: { ...ZERO_TOKENS, input_uncached: 3_000 },
          costMicros: 9_000n + cacheWriteMicros,
          costByClass: {
            input_uncached: 9_000n,
            cache_read: 0n,
            cache_write_5m: cacheWriteMicros,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
          },
          basis: "gateway_observed",
          hasUnpriced: false,
        },
      ],
      tools: [],
    },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    ...rest,
  };
}

function call(
  r: RunTotalsRecord,
  over: Omit<Partial<ToolCallObservation>, "at"> & { at: number },
): ToolCallObservation {
  return {
    runId: r.runId,
    seq: over.at,
    tool: "mcp__slack__list_channels",
    inputDigest: "in-1",
    outputDigest: "out-1",
    isMutating: false,
    resultTokens: 5_000,
    ...over,
    at: new Date(r.startedAt.getTime() + over.at * 1_000),
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

describe("runInputPrice", () => {
  it("is the input the rollup priced over the input tokens the run carried", () => {
    expect(runInputPrice(run())).toEqual({ micros: 9_000n, tokens: 3_000n });
  });

  it("is null for an estimated run, an unpriced run, or a run with no priced input", () => {
    expect(runInputPrice(run({ costBasis: "estimated" }))).toBeNull();
    expect(
      runInputPrice(run({ costBasis: null, costMicros: null })),
    ).toBeNull();
    const noInput = run();
    noInput.breakdown.models[0]!.tokens.input_uncached = 0;
    expect(runInputPrice(noInput)).toBeNull();
  });
});

describe("cache writes never read", () => {
  const cacheRun = (
    over: Partial<RunTotalsRecord> & { cacheWriteMicros?: bigint } = {},
  ) =>
    run({
      cacheWriteMicros: 40_000n,
      tokens: { ...ZERO_TOKENS, input_uncached: 3_000, cache_write_5m: 8_000 },
      ...over,
    });

  it("saves the write premium: the write cost minus the written tokens at the run's input price", () => {
    const r = cacheRun();
    const [finding, ...rest] = detect({ runs: [r] });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "cache_writes_never_read",
      level: "operator",
      subject: OPERATOR,
      savingMicros: 40_000n - 24_000n,
      basis: "gateway_observed",
      confidence: "high",
      citedRuns: [r.runId],
    });
    expect(finding!.evidence).toMatchObject({
      calls: 1,
      coveredCalls: 1,
      measuredTokens: 8_000,
      measuredMicros: "40000",
      counterfactualMicros: "24000",
      operatorKeys: [OPERATOR],
    });
  });

  it("cites the agent when the run names no operator", () => {
    const [finding] = detect({ runs: [cacheRun({ operatorKey: null })] });
    expect(finding).toMatchObject({ level: "agent", subject: AGENT });
  });

  it("writes nothing for a run that read its cache back or wrote none", () => {
    expect(
      detect({
        runs: [
          cacheRun({
            tokens: {
              ...ZERO_TOKENS,
              input_uncached: 3_000,
              cache_write_5m: 8_000,
              cache_read: 1,
            },
          }),
          run(),
        ],
      }),
    ).toEqual([]);
  });

  it("writes nothing when the premium is under a cent", () => {
    const r = cacheRun({ cacheWriteMicros: 24_000n + MIN_SAVING_MICROS - 1n });
    expect(detect({ runs: [r] })).toEqual([]);
  });
});

describe("repeated shell commands and duplicate tool calls", () => {
  it("prices a repeat with an identical input and output at the run's input price, against nothing", () => {
    const r = run();
    const calls = [1, 2, 3].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true, resultTokens: 4_000 }),
    );
    const [finding] = detect({ runs: [r], toolCalls: calls });
    expect(finding).toMatchObject({
      kind: "repeated_shell_commands",
      level: "tool",
      subject: "Bash",
      savingMicros: 2n * 12_000n,
      confidence: "high",
    });
    expect(finding!.evidence).toMatchObject({
      calls: 2,
      counterfactualTokens: 0,
    });
  });

  it("cites a read-only tool's repeat at the run's agent", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [call(r, { at: 1 }), call(r, { at: 2 })],
    });
    expect(finding).toMatchObject({
      kind: "duplicate_tool_calls",
      level: "agent",
      subject: AGENT,
      savingMicros: 15_000n,
    });
  });

  it("is not a repeat when the output changed, or when a non-shell tool writes", () => {
    const r = run();
    expect(
      detect({
        runs: [r],
        toolCalls: [
          call(r, { at: 1 }),
          call(r, { at: 2, outputDigest: "out-2" }),
          call(r, { at: 3, tool: "Write", isMutating: true, inputDigest: "w" }),
          call(r, { at: 4, tool: "Write", isMutating: true, inputDigest: "w" }),
        ],
      }),
    ).toEqual([]);
  });

  it("is medium confidence when a tenth or more of the repeats carry no result tokens", () => {
    const r = run();
    const toolCalls = [
      call(r, { at: 1, tool: "Bash", resultTokens: 5_000 }),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((at) =>
        call(r, { at, tool: "Bash", resultTokens: 5_000 }),
      ),
      call(r, { at: 10, tool: "Bash", resultTokens: null }),
    ];
    const [finding] = detect({ runs: [r], toolCalls });
    expect(finding).toMatchObject({ confidence: "medium" });
    expect(finding!.evidence).toMatchObject({ calls: 9, coveredCalls: 8 });
  });

  it("writes nothing when fewer than half the repeats are covered", () => {
    const r = run();
    const toolCalls = [1, 2, 3, 4].map((at) =>
      call(r, { at, tool: "Bash", resultTokens: at === 2 ? 50_000 : null }),
    );
    expect(detect({ runs: [r], toolCalls })).toEqual([]);
  });
});

describe("a result another run already fetched", () => {
  it("is not a finding: the new run's context has to carry the result either way", () => {
    const [a, b, c] = [run(), run(), run()];
    expect(
      detect({
        runs: [a!, b!, c!],
        toolCalls: [
          call(a!, { at: 1 }),
          call(b!, { at: 1 }),
          call(c!, { at: 1 }),
        ],
      }),
    ).toEqual([]);
  });

  it("is still an unpaged result when it is above the threshold", () => {
    const [a, b] = [run(), run()];
    const tokens = UNPAGED_RESULT_TOKENS + 1_000;
    const [finding, ...rest] = detect({
      runs: [a!, b!],
      toolCalls: [
        call(a!, { at: 1, resultTokens: tokens }),
        call(b!, { at: 1, resultTokens: tokens }),
      ],
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ kind: "unpaged_results" });
    expect(finding!.citedRuns).toHaveLength(2);
  });
});

describe("unpaged results", () => {
  it("re-prices a result above the threshold at one page", () => {
    const r = run();
    const tokens = UNPAGED_RESULT_TOKENS + 1_000;
    const [finding] = detect({
      runs: [r],
      toolCalls: [
        call(r, {
          at: 1,
          tool: "aws_billing__get_cost_and_usage",
          resultTokens: tokens,
        }),
      ],
    });
    expect(finding).toMatchObject({
      kind: "unpaged_results",
      subject: "aws_billing__get_cost_and_usage",
      savingMicros: BigInt((tokens - PAGE_TOKENS) * 3),
    });
    expect(finding!.evidence).toMatchObject({
      measuredTokens: tokens,
      counterfactualTokens: PAGE_TOKENS,
    });
  });

  it("does not also count a large result a repeat already claimed", () => {
    const r = run();
    const big = UNPAGED_RESULT_TOKENS + 1_000;
    const findings = detect({
      runs: [r],
      toolCalls: [
        call(r, { at: 1, tool: "Bash", resultTokens: big }),
        call(r, { at: 2, tool: "Bash", resultTokens: big }),
      ],
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["repeated_shell_commands", 1],
      ["unpaged_results", 1],
    ]);
  });

  it("does not flag a result at the threshold", () => {
    const r = run();
    expect(
      detect({
        runs: [r],
        toolCalls: [call(r, { at: 1, resultTokens: UNPAGED_RESULT_TOKENS })],
      }),
    ).toEqual([]);
  });
});

describe("detectFindings", () => {
  it("cites only runs that started after a person applied or dismissed the finding", () => {
    const before = run();
    const after = run();
    const toolCalls = [before, after].flatMap((r) => [
      call(r, { at: 1, tool: "Bash", isMutating: true }),
      call(r, { at: 2, tool: "Bash", isMutating: true }),
    ]);
    const since = new Date(before.startedAt.getTime() + 1);
    const decidedSince = new Map([
      [findingFingerprint("repeated_shell_commands", "tool", "Bash"), since],
    ]);
    const [finding] = detect({
      runs: [before, after],
      toolCalls,
      decidedSince,
    });
    expect(finding!.citedRuns).toEqual([after.runId]);
    expect(finding!.windowStart).toEqual(since);
  });

  it("ignores tool calls of runs the rollup has no row for", () => {
    const r = run();
    const orphan = {
      ...call(r, { at: 1, tool: "Bash" }),
      runId: "tse_unrolled",
    };
    expect(
      detect({ runs: [], toolCalls: [orphan, { ...orphan, seq: 2 }] }),
    ).toEqual([]);
  });

  it("ranks by saving, stamps the tool-call window, and itemises at most ten runs", () => {
    const shellRuns = Array.from({ length: 12 }, () => run());
    const cache = run({
      cacheWriteMicros: 900_000n,
      tokens: { ...ZERO_TOKENS, input_uncached: 3_000, cache_write_5m: 8_000 },
    });
    const toolWindowStart = new Date(START.getTime() + 86_400_000);
    const findings = detect({
      runs: [...shellRuns, cache],
      toolWindowStart,
      toolCalls: shellRuns.flatMap((r) => [
        call(r, { at: 1, tool: "Bash", isMutating: true }),
        call(r, { at: 2, tool: "Bash", isMutating: true }),
      ]),
    });
    expect(findings.map((f) => f.kind)).toEqual([
      "cache_writes_never_read",
      "repeated_shell_commands",
    ]);
    expect(findings[0]!.windowStart).toEqual(START);
    expect(findings[1]!.windowStart).toEqual(toolWindowStart);
    expect(findings[1]!.citedRuns).toHaveLength(12);
    expect(findings[1]!.evidence.runs).toHaveLength(10);
  });
});

describe("the limits the contracts carry", () => {
  it("keeps every open finding inside one list_findings answer", () => {
    expect(FINDINGS_PER_KIND * FINDING_KINDS.length).toBeLessThanOrEqual(
      FINDINGS_LIST_MAX,
    );
  });

  it("itemises exactly as many runs as the evidence contract accepts", () => {
    const money = { micros: "0", currency: "USD" };
    const evidence = (runs: number) => ({
      calls: runs,
      coveredCalls: runs,
      measuredTokens: 0,
      counterfactualTokens: 0,
      measured: money,
      counterfactual: money,
      runs: Array.from({ length: runs }, (_, i) => ({
        runId: `tse_${i}`,
        startedAt: START.toISOString(),
        calls: 1,
        measuredTokens: 0,
        counterfactualTokens: 0,
        measured: money,
        counterfactual: money,
      })),
    });
    expect(
      findingEvidenceSchema.safeParse(evidence(EVIDENCE_RUNS)).success,
    ).toBe(true);
    expect(
      findingEvidenceSchema.safeParse(evidence(EVIDENCE_RUNS + 1)).success,
    ).toBe(false);
  });
});
