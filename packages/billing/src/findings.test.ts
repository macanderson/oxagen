import { FINDING_KINDS } from "@oxagen/database/schema";
import { FINDINGS_LIST_MAX } from "@oxagen/oxagen/contracts/finding.list";
import {
  findingEvidenceSchema,
  findingRunCitationSchema,
} from "@oxagen/oxagen/contracts/finding.shared";
import { describe, expect, it } from "vitest";
import {
  runInputPrice,
  ZERO_TOKENS,
  type RunTotalsRecord,
} from "./cost-rollup";
import {
  countClaims,
  DETECTED_KINDS,
  DETECTORS,
  detectFindings,
  EVIDENCE_RUNS,
  FINDING_FRAMES_PER_RUN,
  FINDINGS_MAX,
  FINDINGS_PER_KIND,
  findingFingerprint,
  microsOf,
  MIN_SAVING_MICROS,
  PAGE_TOKENS,
  SPIN_LOOP_REPEATS,
  timeOf,
  UNPAGED_RESULT_TOKENS,
  type ClaimRow,
  type DetectInput,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./findings";
import { resultMeasure, type FrameClassPrices } from "./findings/shared";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
/** What one model request costs in these tests, and the tokens it carries. */
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;

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
    sessionUuid: null,
    ...over,
    at: new Date(r.startedAt.getTime() + over.at * 1_000),
  };
}

/** A model request at `time`, keyed the way the store keys it. */
function frameAt(
  time: Date,
  costMicros: bigint | null = TURN_MICROS,
): PricedRequestFrame {
  return {
    key: `${time.toISOString()}#0`,
    at: time,
    costMicros,
    tokens: TURN_TOKENS,
    basis: costMicros === null ? null : "gateway_observed",
  };
}

/** The model request one millisecond before the call at `at` seconds into the run. */
function request(
  r: RunTotalsRecord,
  at: number,
  costMicros: bigint | null = TURN_MICROS,
): PricedRequestFrame {
  return frameAt(new Date(r.startedAt.getTime() + at * 1_000 - 1), costMicros);
}

/** One model request just before each call, so each call is its own turn. */
function turns(
  calls: readonly ToolCallObservation[],
  costMicros: bigint | null = TURN_MICROS,
): Map<string, PricedRequestFrame[]> {
  const out = new Map<string, PricedRequestFrame[]>();
  for (const c of calls) {
    const frame = frameAt(new Date(c.at.getTime() - 1), costMicros);
    const list = out.get(c.runId) ?? [];
    if (!list.some((f) => f.key === frame.key)) list.push(frame);
    out.set(c.runId, list);
  }
  return out;
}

/** Uncached input at 3 micros a token, the run's own input price; no other class is priced. */
const READ_PRICES: FrameClassPrices = {
  input_uncached: {
    entryId: "list:test:input_uncached",
    microsPerMillion: 3_000_000n,
    currency: "USD",
    source: "list",
  },
  cache_read: null,
  cache_write_5m: null,
  cache_write_1h: null,
  output: null,
  reasoning: null,
  server_tool_request: null,
};

/**
 * The same frames with class tokens and class prices, so a carry of a large
 * result has a read price of its own. Detector 5 prices each carry from the
 * frame that made it and leaves an unpriced one uncovered (#4585), so a frame
 * with neither never produces an unpaged finding.
 */
function priced(
  frames: Map<string, PricedRequestFrame[]>,
): Map<string, PricedRequestFrame[]> {
  const out = new Map<string, PricedRequestFrame[]>();
  for (const [runId, list] of frames)
    out.set(
      runId,
      list.map((f) => ({
        ...f,
        classTokens: { ...ZERO_TOKENS, input_uncached: f.tokens },
        classPrices: READ_PRICES,
      })),
    );
  return out;
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

/**
 * #4572 item 7: a run whose model made a second call the book could not
 * price. Its tokens count both calls, 6,000 input tokens, and its cost only
 * the priced one, 9,000 micros for 3,000. The old rate read 1.5 micros a
 * token, half the 3 the priced call paid.
 */
function withUnpricedCall(r: RunTotalsRecord): RunTotalsRecord {
  const [model] = r.breakdown.models;
  model!.tokens = { ...model!.tokens, input_uncached: 6_000 };
  model!.calls = 2;
  model!.hasUnpriced = true;
  model!.pricedTokens = { ...ZERO_TOKENS, input_uncached: 3_000 };
  return r;
}

describe("the input rate of a run with an unpriced call (#4572)", () => {
  it("reads the rate over the priced calls' tokens", () => {
    expect(runInputPrice(withUnpricedCall(run()))).toEqual({
      micros: 9_000n,
      tokens: 3_000n,
    });
  });

  it("has no rate for a row with no priced tokens, rather than a low one", () => {
    const legacy = withUnpricedCall(run());
    delete legacy.breakdown.models[0]!.pricedTokens;
    expect(runInputPrice(legacy)).toBeNull();
  });

  // resultMeasure is the shared caller. The unpaged-results detector also
  // leaves a partly priced run uncovered (#4544), so it reads no rate there.
  it("prices a result at the priced calls' rate in resultMeasure", () => {
    const r = withUnpricedCall(run());
    const tokens = UNPAGED_RESULT_TOKENS + 1_000;
    const measure = resultMeasure(r, tokens, () => PAGE_TOKENS);
    // At 1.5 micros a token both sides read half these.
    expect(measure.micros).toEqual({
      measured: BigInt(tokens * 3),
      counterfactual: BigInt(PAGE_TOKENS * 3),
    });
    const legacy = withUnpricedCall(run());
    delete legacy.breakdown.models[0]!.pricedTokens;
    expect(resultMeasure(legacy, tokens, () => PAGE_TOKENS).micros).toBeNull();
  });

  it("prices the cache writes' counterfactual at the priced calls' rate", () => {
    const r = withUnpricedCall(
      run({
        cacheWriteMicros: 40_000n,
        tokens: {
          ...ZERO_TOKENS,
          input_uncached: 6_000,
          cache_write_5m: 8_000,
        },
      }),
    );
    const [finding] = detect({ runs: [r] });
    // 8,000 written tokens at 3 micros, not 1.5: a saving of 16,000, not
    // 28,000.
    expect(finding).toMatchObject({
      kind: "cache_writes_never_read",
      savingMicros: 40_000n - 24_000n,
    });
  });
});

describe("microsOf", () => {
  const second = Date.parse("2026-09-27T05:30:12Z") * 1_000;

  it("reads the store's six fractional digits, which a Date drops", () => {
    expect(microsOf("2026-09-27T05:30:12.500500Z")).toBe(second + 500_500);
    expect(microsOf("2026-09-27T05:30:12.500900Z")).toBe(second + 500_900);
  });

  it("pads a shorter fraction, drops digits past the sixth, and reads an offset", () => {
    expect(microsOf("2026-09-27T05:30:12.5Z")).toBe(second + 500_000);
    expect(microsOf("2026-09-27T05:30:12.5005009Z")).toBe(second + 500_500);
    expect(microsOf("2026-09-27T07:30:12.000001+02:00")).toBe(second + 1);
  });

  it("reads a time with no fraction as a whole second", () => {
    expect(microsOf("2026-09-27T05:30:12Z")).toBe(second);
  });

  it("is what timeOf uses, and timeOf falls back to the Date", () => {
    const at = new Date("2026-09-27T05:30:12.500Z");
    expect(timeOf({ at, atMicros: second + 500_500 })).toBe(second + 500_500);
    expect(timeOf({ at })).toBe(second + 500_000);
  });
});

describe("the detector registry", () => {
  it("runs spin loops first, then retry loops, then repeats, then recurring runs, then spend with no outcome, then the detectors that claim no frame", () => {
    expect(DETECTORS.map((d) => [d.kinds, d.counting])).toEqual([
      [["spin_loops"], 1],
      [["retry_loops"], 1],
      [["repeated_shell_commands", "duplicate_tool_calls"], 1],
      [["recurring_runs"], 7],
      [["spend_with_no_outcome"], 8],
      [["cache_writes_never_read"], null],
      [["idle_cache_rewrites"], null],
      [["cache_busts"], null],
      [["unpaged_results"], null],
      [["standing_context"], null],
      [["model_class_fit"], null],
      [["repeated_instructions"], null],
    ]);
  });

  it("writes only kinds the schema accepts", () => {
    for (const kind of DETECTED_KINDS) expect(FINDING_KINDS).toContain(kind);
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
    // It prices a part of each request, so it claims no frame.
    expect(finding!.claims).toBeUndefined();
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
  it("counts each turn that only re-ran a shell command at its own cost, against nothing", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true, resultTokens: 4_000 }),
    );
    const [finding, ...rest] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "repeated_shell_commands",
      level: "tool",
      subject: "Bash",
      savingMicros: 2n * TURN_MICROS,
      basis: "gateway_observed",
      confidence: "high",
    });
    expect(finding!.why).toContain("2 calls on 1 run");
    expect(finding!.evidence).toMatchObject({
      calls: 2,
      coveredCalls: 2,
      measuredTokens: 2 * TURN_TOKENS,
      counterfactualTokens: 0,
      counterfactualMicros: "0",
    });
  });

  it("claims each counted turn's frame as detector 1, under the run's operator", () => {
    const r = run();
    const toolCalls = [1, 2].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true }),
    );
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    const frame = request(r, 2);
    expect(finding!.claims).toEqual([
      {
        detector: 1,
        runId: r.runId,
        frameKey: frame.key,
        frameAt: frame.at,
        operatorKey: OPERATOR,
        costMicros: TURN_MICROS,
      },
    ]);
  });

  // #4506 pass 7: the Spend card labels `evidence.calls` as calls, so a
  // counted turn adds each call it made. Its price still counts once.
  it("prices a turn that made several repeats once, and counts each of its calls", () => {
    const r = run();
    const toolCalls = [1, 2, 3, 4].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true }),
    );
    const [finding] = detect({
      runs: [r],
      toolCalls,
      // One request made the first call, and one more made the other three.
      frames: new Map([[r.runId, [request(r, 1), request(r, 2)]]]),
    });
    expect(finding).toMatchObject({ savingMicros: TURN_MICROS });
    expect(finding!.evidence).toMatchObject({
      calls: 3,
      coveredCalls: 3,
      measuredTokens: TURN_TOKENS,
    });
    expect(finding!.evidence.runs[0]).toMatchObject({ calls: 3 });
    expect(finding!.evidence.frames?.[r.runId]?.total).toBe(3);
    expect(finding!.claims).toHaveLength(1);
    expect(finding!.why).toBe(
      "3 calls on 1 run re-ran shell commands whose identical input had already returned the identical output earlier in the run. Each came from a turn that made no other call.",
    );
  });

  it("does not count a turn that also made a new call", () => {
    const r = run();
    const toolCalls = [
      call(r, { at: 1, tool: "Bash", isMutating: true }),
      call(r, { at: 2, tool: "Bash", isMutating: true }),
      call(r, { at: 3, tool: "Bash", isMutating: true, inputDigest: "in-2" }),
    ];
    expect(
      detect({
        runs: [r],
        toolCalls,
        frames: new Map([[r.runId, [request(r, 1), request(r, 2)]]]),
      }),
    ).toEqual([]);
  });

  it("does not count a turn that made a call with no input digest", () => {
    const r = run();
    const shell = { tool: "Bash", isMutating: true };
    // The second request repeats both calls of the first, but the hook
    // recorded no input for one of them, so it may have done new work.
    const toolCalls = [
      call(r, { at: 1, ...shell }),
      call(r, { at: 1.5, ...shell, inputDigest: "" }),
      call(r, { at: 2, ...shell }),
      call(r, { at: 2.5, ...shell, inputDigest: "" }),
    ];
    expect(
      detect({
        runs: [r],
        toolCalls,
        frames: new Map([[r.runId, [request(r, 1), request(r, 2)]]]),
      }),
    ).toEqual([]);
  });

  it("cites a read-only tool's repeat at the run's agent", () => {
    const r = run();
    const toolCalls = [call(r, { at: 1 }), call(r, { at: 2 })];
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding).toMatchObject({
      kind: "duplicate_tool_calls",
      level: "agent",
      subject: AGENT,
      savingMicros: TURN_MICROS,
    });
  });

  it("cites a read-only tool's repeat at the run's operator when the run names no agent", () => {
    const r = run({ agentKey: null });
    const toolCalls = [call(r, { at: 1 }), call(r, { at: 2 })];
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding).toMatchObject({
      kind: "duplicate_tool_calls",
      level: "operator",
      subject: OPERATOR,
    });
  });

  it("cites a turn that repeated a shell command and a read-only call as a duplicate tool call", () => {
    const r = run();
    const toolCalls = [
      call(r, { at: 1, tool: "Bash", isMutating: true }),
      call(r, { at: 1.5 }),
      call(r, { at: 2, tool: "Bash", isMutating: true }),
      call(r, { at: 2.5 }),
    ];
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: new Map([[r.runId, [request(r, 1), request(r, 2)]]]),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["duplicate_tool_calls", 2],
    ]);
  });

  it("is not a repeat when the output changed, or when a non-shell tool writes", () => {
    const r = run();
    const toolCalls = [
      call(r, { at: 1 }),
      call(r, { at: 2, outputDigest: "out-2" }),
      call(r, { at: 3, tool: "Write", isMutating: true, inputDigest: "w" }),
      call(r, { at: 4, tool: "Write", isMutating: true, inputDigest: "w" }),
    ];
    expect(
      detect({ runs: [r], toolCalls, frames: turns(toolCalls) }),
    ).toEqual([]);
  });

  it("is medium confidence when a tenth or more of the counted turns have no price", () => {
    const r = run();
    const toolCalls = Array.from({ length: 10 }, (_, i) =>
      call(r, { at: i + 1, tool: "Bash", isMutating: true }),
    );
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: new Map([
        [
          r.runId,
          [
            ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((at) => request(r, at)),
            request(r, 10, null),
          ],
        ],
      ]),
    });
    expect(finding).toMatchObject({
      confidence: "medium",
      savingMicros: 8n * TURN_MICROS,
    });
    expect(finding!.evidence).toMatchObject({ calls: 9, coveredCalls: 8 });
    // An unpriced turn is cited, and it claims no frame.
    expect(finding!.claims).toHaveLength(8);
  });

  it("writes nothing when fewer than half the counted turns are priced", () => {
    const r = run();
    const toolCalls = [1, 2, 3, 4].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true }),
    );
    expect(
      detect({
        runs: [r],
        toolCalls,
        frames: new Map([
          [
            r.runId,
            [
              request(r, 1),
              request(r, 2),
              request(r, 3, null),
              request(r, 4, null),
            ],
          ],
        ]),
      }),
    ).toEqual([]);
  });

  it("cites each repeat, and prices none, when the run's frames were not read", () => {
    const r = run();
    const other = run();
    const toolCalls = [1, 2, 3].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true }),
    );
    expect(detect({ runs: [r], toolCalls })).toEqual([]);
    expect(
      detect({
        runs: [r, other],
        toolCalls,
        frames: new Map([[other.runId, [request(other, 1)]]]),
      }),
    ).toEqual([]);
  });

  it("gives each call to the latest request at or before it, whatever order the frames arrive in", () => {
    const r = run();
    const toolCalls = [1, 2].map((at) =>
      call(r, { at, tool: "Bash", isMutating: true }),
    );
    // The request at 1.5s made the call at 2s; the request at 3s made no call.
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: new Map([
        [r.runId, [request(r, 3), request(r, 1.5), request(r, 1)]],
      ]),
    });
    expect(finding!.claims?.map((c) => c.frameKey)).toEqual([
      request(r, 1.5).key,
    ]);
  });

  it("gives a call to the request before it when a later request shares its millisecond", () => {
    const r = run();
    const base = r.startedAt.getTime();
    const toolCalls = [
      call(r, { at: 2 }),
      call(r, { at: 3.5, atMicros: (base + 3_500) * 1_000 + 500, seq: 3 }),
      call(r, { at: 4, inputDigest: "in-2", seq: 4 }),
    ];
    const made = frameAt(new Date(base + 3_000));
    const later = {
      ...frameAt(new Date(base + 3_500)),
      atMicros: (base + 3_500) * 1_000 + 900,
    };
    // By the millisecond alone, `later` made the repeat and the new call, so
    // nothing would count.
    const [finding, ...rest] = detect({
      runs: [r],
      toolCalls,
      frames: new Map([
        [r.runId, [frameAt(new Date(base + 1_000)), made, later]],
      ]),
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "duplicate_tool_calls",
      savingMicros: TURN_MICROS,
    });
    expect(finding!.claims?.map((c) => c.frameKey)).toEqual([made.key]);
  });

  describe("two chains whose model calls share a millisecond", () => {
    const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";
    const shell = { tool: "Bash", isMutating: true };

    /**
     * The root and a subagent each run a command, then each repeat it from a
     * request that finished in the same millisecond as the other's.
     * `tacho_events.ts` keeps milliseconds, so the two frames share `at`,
     * and the store keys them by their place at that instant.
     */
    function tiedChains(extra: (r: RunTotalsRecord) => ToolCallObservation[]) {
      const r = run();
      const base = r.startedAt.getTime();
      const tied = new Date(base + 2_000);
      const rootTied = { ...frameAt(tied), sessionUuid: null };
      const subTied = {
        ...frameAt(tied),
        key: `${tied.toISOString()}#1`,
        sessionUuid: SUBAGENT,
      };
      const toolCalls = [
        call(r, { at: 1, seq: 1, ...shell }),
        call(r, {
          at: 1,
          seq: 1,
          ...shell,
          inputDigest: "sub-in",
          sessionUuid: SUBAGENT,
        }),
        call(r, { at: 2.25, seq: 2, ...shell }),
        call(r, {
          at: 2.5,
          seq: 2,
          ...shell,
          inputDigest: "sub-in",
          sessionUuid: SUBAGENT,
        }),
        ...extra(r),
      ];
      const frames = new Map<string, PricedRequestFrame[]>([
        [
          r.runId,
          [
            { ...frameAt(new Date(base + 500)), sessionUuid: null },
            { ...frameAt(new Date(base + 600)), sessionUuid: SUBAGENT },
            rootTied,
            subTied,
          ],
        ],
      ]);
      return { r, toolCalls, frames, rootTied, subTied };
    }

    it("counts and prices each chain's request on its own", () => {
      const { r, toolCalls, frames, rootTied, subTied } = tiedChains(() => []);
      // By time alone, both repeats would land on the frame that sorts last,
      // and one request would be counted for two.
      const [finding, ...rest] = detect({ runs: [r], toolCalls, frames });
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({
        kind: "repeated_shell_commands",
        savingMicros: 2n * TURN_MICROS,
      });
      expect(finding!.evidence.calls).toBe(2);
      expect(finding!.claims?.map((c) => c.frameKey)).toEqual([
        rootTied.key,
        subTied.key,
      ]);
    });

    it("still counts one chain's request when the other chain's request did new work", () => {
      const { r, toolCalls, frames, subTied } = tiedChains((record) => [
        call(record, { at: 2.75, seq: 3, ...shell, inputDigest: "in-2" }),
      ]);
      // By time alone, the root's new call would land on the subagent's
      // request as well, and neither request would count.
      const [finding, ...rest] = detect({ runs: [r], toolCalls, frames });
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({
        kind: "repeated_shell_commands",
        savingMicros: TURN_MICROS,
      });
      expect(finding!.evidence.calls).toBe(1);
      expect(finding!.claims?.map((c) => c.frameKey)).toEqual([subTied.key]);
    });

    it("gives a subagent's call the run's latest request when its own chain recorded none", () => {
      // The proxy records a subagent's model call on the root chain
      // (ADR-168), so the subagent's calls fall back to time.
      const r = run();
      const base = r.startedAt.getTime();
      const toolCalls = [1, 2.5].map((at) =>
        call(r, { at, seq: at * 2, ...shell, sessionUuid: SUBAGENT }),
      );
      const later = { ...frameAt(new Date(base + 2_000)), sessionUuid: null };
      const [finding] = detect({
        runs: [r],
        toolCalls,
        frames: new Map([
          [
            r.runId,
            [{ ...frameAt(new Date(base + 500)), sessionUuid: null }, later],
          ],
        ]),
      });
      expect(finding!.claims?.map((c) => c.frameKey)).toEqual([later.key]);
    });
  });

  describe("calls and requests of one millisecond (#4506)", () => {
    const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";
    const shell = { tool: "Bash", isMutating: true };

    /** A frame on `chain` (null for the run's own) at `ms` into the run, keyed by its chain and seq. */
    function chainFrame(
      r: RunTotalsRecord,
      ms: number,
      chain: string | null,
      frameSeq: number,
      costMicros: bigint | null = TURN_MICROS,
    ): PricedRequestFrame {
      const at = new Date(r.startedAt.getTime() + ms);
      return {
        ...frameAt(at, costMicros),
        key: `${at.toISOString()}#${chain ?? "root"}:${frameSeq}`,
        sessionUuid: chain,
        seq: frameSeq,
      };
    }

    // Pass 4: `tacho_events.ts` keeps milliseconds, so two chains can make
    // one identical call in one millisecond, each at the same seq on its own
    // chain. Neither read the other's result.
    it("judges two chains' identical calls of one millisecond against the calls before them, never against each other", () => {
      const r = run();
      const toolCalls = [
        call(r, { at: 2, seq: 3, ...shell }),
        call(r, { at: 2, seq: 3, ...shell, sessionUuid: SUBAGENT }),
      ];
      const frames = new Map([
        [
          r.runId,
          [
            chainFrame(r, 1_000, null, 2),
            chainFrame(r, 1_000, SUBAGENT, 2),
            chainFrame(r, 2_500, null, 4),
          ],
        ],
      ]);
      // Whichever of the two the store returns first, neither repeats.
      expect(detect({ runs: [r], toolCalls, frames })).toEqual([]);
      expect(
        detect({ runs: [r], toolCalls: [...toolCalls].reverse(), frames }),
      ).toEqual([]);
      // A later identical call still repeats them.
      const [finding, ...rest] = detect({
        runs: [r],
        toolCalls: [...toolCalls, call(r, { at: 3, seq: 5, ...shell })],
        frames,
      });
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({
        kind: "repeated_shell_commands",
        savingMicros: TURN_MICROS,
      });
      expect(finding!.claims?.map((c) => c.frameKey)).toEqual([
        chainFrame(r, 2_500, null, 4).key,
      ]);
    });

    // Pass 4: one chain records two model calls in one millisecond. Each
    // call of that millisecond belongs to the frame before it by seq.
    it("evaluates and prices two requests of one chain in one millisecond apart, by seq", () => {
      const r = run();
      const first = chainFrame(r, 2_000, null, 10, 12_000n);
      const second = chainFrame(r, 2_000, null, 12, 30_000n);
      const frames = new Map([
        [r.runId, [chainFrame(r, 500, null, 1), second, first]],
      ]);
      // The first request re-runs a command and the second runs a new one,
      // so only the first counts.
      const original = call(r, { at: 1, seq: 2, ...shell });
      const [one, ...none] = detect({
        runs: [r],
        toolCalls: [
          original,
          call(r, { at: 2, seq: 11, ...shell }),
          call(r, { at: 2, seq: 13, ...shell, inputDigest: "in-2" }),
        ],
        frames,
      });
      expect(none).toEqual([]);
      expect(one).toMatchObject({
        kind: "repeated_shell_commands",
        savingMicros: 12_000n,
      });
      expect(one!.claims?.map((c) => c.frameKey)).toEqual([first.key]);

      // When both only repeat, each counts at its own price.
      const [both] = detect({
        runs: [r],
        toolCalls: [
          original,
          call(r, { at: 1.5, seq: 3, ...shell, inputDigest: "in-2" }),
          call(r, { at: 2, seq: 11, ...shell }),
          call(r, { at: 2, seq: 13, ...shell, inputDigest: "in-2" }),
        ],
        frames,
      });
      expect(both).toMatchObject({
        kind: "repeated_shell_commands",
        savingMicros: 42_000n,
      });
      expect(both!.claims?.map((c) => [c.frameKey, c.costMicros])).toEqual([
        [first.key, 12_000n],
        [second.key, 30_000n],
      ]);
    });

    // Pass 5: the proxy records a subagent's model call on the root chain
    // (ADR-168), so a root frame later than the subagent's own can be the
    // subagent's next request.
    it("gives a subagent's call a root chain request later than its own chain's", () => {
      const r = run();
      const own = chainFrame(r, 1_000, SUBAGENT, 1);
      const proxied = chainFrame(r, 2_000, null, 7);
      const toolCalls = [
        call(r, { at: 1.5, seq: 2, ...shell, sessionUuid: SUBAGENT }),
        call(r, { at: 2.5, seq: 3, ...shell, sessionUuid: SUBAGENT }),
      ];
      const [finding, ...rest] = detect({
        runs: [r],
        toolCalls,
        frames: new Map([[r.runId, [own, proxied]]]),
      });
      expect(rest).toEqual([]);
      expect(finding!.claims?.map((c) => c.frameKey)).toEqual([proxied.key]);

      // A later frame on another subagent's chain is not the subagent's.
      const sibling = chainFrame(r, 2_000, "00000000-0000-4000-8000-0000000000dd", 4);
      expect(
        detect({
          runs: [r],
          toolCalls,
          frames: new Map([[r.runId, [own, sibling]]]),
        }),
      ).toEqual([]);
    });

    // Pass 7: a model call that names no model has no price. The repeats it
    // made form their own request, which nothing prices, so no finding claims
    // the priced request before it.
    it("keeps the repeats after a call that named no model out of the priced request before it", () => {
      const r = run();
      const made = chainFrame(r, 500, null, 1);
      const answered = chainFrame(r, 1_500, null, 3);
      const modelless: PricedRequestFrame = {
        ...chainFrame(r, 2_500, null, 4, null),
        model: "",
        noModel: true,
      };
      const toolCalls = [
        call(r, { at: 1, seq: 2, ...shell }),
        call(r, { at: 3, seq: 5, ...shell }),
      ];
      const frames = new Map([[r.runId, [made, answered]]]);
      // Without the call that named no model, the repeat joins the request
      // that only answered in text, and that request's price is claimed.
      const [merged] = detect({ runs: [r], toolCalls, frames });
      expect(merged!.claims?.map((c) => c.frameKey)).toEqual([answered.key]);

      expect(
        detect({
          runs: [r],
          toolCalls,
          frames,
          modellessFrames: new Map([[r.runId, [modelless]]]),
        }),
      ).toEqual([]);
    });
  });
});

describe("spin loops", () => {
  const same = (
    r: RunTotalsRecord,
    n: number,
    over: Omit<Partial<ToolCallObservation>, "at"> = {},
  ) =>
    Array.from({ length: n }, (_, i) => call(r, { at: i + 1, ...over }));

  it(`finds ${SPIN_LOOP_REPEATS} repeats of one call in a row, prices each turn, and claims its frame`, () => {
    const r = run();
    const toolCalls = same(r, SPIN_LOOP_REPEATS + 1);
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => f.kind)).toEqual(["spin_loops"]);
    const [finding] = findings;
    expect(finding).toMatchObject({
      level: "agent",
      subject: AGENT,
      savingMicros: BigInt(SPIN_LOOP_REPEATS) * TURN_MICROS,
      confidence: "high",
    });
    expect(finding!.evidence.calls).toBe(SPIN_LOOP_REPEATS);
    expect(finding!.why).toContain(`${SPIN_LOOP_REPEATS} turns`);
    expect(finding!.claims).toHaveLength(SPIN_LOOP_REPEATS);
    expect(finding!.claims![0]).toEqual({
      detector: 1,
      runId: r.runId,
      frameKey: request(r, 2).key,
      frameAt: request(r, 2).at,
      operatorKey: OPERATOR,
      costMicros: TURN_MICROS,
    });
  });

  it(`leaves ${SPIN_LOOP_REPEATS - 1} repeats in a row to the duplicate tool call finding`, () => {
    const r = run();
    const toolCalls = same(r, SPIN_LOOP_REPEATS);
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["duplicate_tool_calls", SPIN_LOOP_REPEATS - 1],
    ]);
  });

  it("takes a shell loop ahead of the repeated shell command finding", () => {
    const r = run();
    const toolCalls = same(r, SPIN_LOOP_REPEATS + 1, {
      tool: "Bash",
      isMutating: true,
    });
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["spin_loops", SPIN_LOOP_REPEATS],
    ]);
  });

  it("breaks a streak at a different call", () => {
    const r = run();
    const half = SPIN_LOOP_REPEATS / 2;
    const toolCalls = [
      ...Array.from({ length: half + 1 }, (_, i) => call(r, { at: i + 1 })),
      call(r, { at: half + 2, inputDigest: "in-2" }),
      ...Array.from({ length: half }, (_, i) => call(r, { at: half + 3 + i })),
    ];
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["duplicate_tool_calls", SPIN_LOOP_REPEATS],
    ]);
  });

  it("reads each chain on its own, so a subagent's call does not break the run's streak", () => {
    const r = run();
    const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";
    const toolCalls = [
      ...same(r, SPIN_LOOP_REPEATS + 1),
      call(r, { at: 5.5, seq: 1, inputDigest: "in-2", sessionUuid: SUBAGENT }),
    ];
    // Each request makes one call, the subagent's too.
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["spin_loops", SPIN_LOOP_REPEATS],
    ]);
  });

  it("cites the run's operator when the run names no agent, and nothing when it names neither", () => {
    const r = run({ agentKey: null });
    const toolCalls = same(r, SPIN_LOOP_REPEATS + 1);
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding).toMatchObject({
      kind: "spin_loops",
      level: "operator",
      subject: OPERATOR,
    });

    const anon = run({ agentKey: null, operatorKey: null });
    const anonCalls = same(anon, SPIN_LOOP_REPEATS + 1);
    expect(
      detect({ runs: [anon], toolCalls: anonCalls, frames: turns(anonCalls) }),
    ).toEqual([]);
  });

  it("cites each looping call, and prices none, when the run's frames were not read", () => {
    const r = run();
    const big = UNPAGED_RESULT_TOKENS + 1_000;
    const toolCalls = same(r, SPIN_LOOP_REPEATS + 1, { resultTokens: big });
    // The first call is still an unpaged result. The loop's calls are cited
    // by the loop, so they are not unpaged results as well.
    expect(
      detect({ runs: [r], toolCalls }).map((f) => [f.kind, f.evidence.calls]),
    ).toEqual([["unpaged_results", 1]]);
  });

  it("cites only runs that started after a person decided the loop finding", () => {
    const before = run();
    const after = run();
    const toolCalls = [before, after].flatMap((r) =>
      same(r, SPIN_LOOP_REPEATS + 1),
    );
    const decidedSince = new Map([
      [
        findingFingerprint("spin_loops", "agent", AGENT),
        new Date(before.startedAt.getTime() + 1),
      ],
    ]);
    const findings = detect({
      runs: [before, after],
      toolCalls,
      decidedSince,
      frames: turns(toolCalls),
    });
    // The decided run's turns are claimed by the loop, so they are not
    // repeats as well.
    expect(findings.map((f) => [f.kind, f.citedRuns])).toEqual([
      ["spin_loops", [after.runId]],
    ]);
  });
});

describe("a result another run already fetched", () => {
  it("is not a finding: the new run's context has to carry the result either way", () => {
    const [a, b, c] = [run(), run(), run()];
    const toolCalls = [
      call(a!, { at: 1 }),
      call(b!, { at: 1 }),
      call(c!, { at: 1 }),
    ];
    expect(
      detect({ runs: [a!, b!, c!], toolCalls, frames: turns(toolCalls) }),
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
  it("re-prices a result above the threshold at one page when the run's frames were not read", () => {
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
    expect(finding!.claims).toBeUndefined();
  });

  it("does not also count a large result a repeat finding cites", () => {
    const r = run();
    const big = UNPAGED_RESULT_TOKENS + 1_000;
    const toolCalls = [
      call(r, { at: 1, tool: "Bash", resultTokens: big }),
      call(r, { at: 2, tool: "Bash", resultTokens: big }),
    ];
    const findings = detect({
      runs: [r],
      toolCalls,
      frames: priced(turns(toolCalls, 100_000n)),
    });
    expect(findings.map((f) => [f.kind, f.evidence.calls])).toEqual([
      ["repeated_shell_commands", 1],
      ["unpaged_results", 1],
    ]);
  });

  it("leaves a large repeat to the repeat finding when the run's frames were not read", () => {
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
      ["unpaged_results", 1],
    ]);
  });

  it("does not flag a result at the threshold when the run's frames were not read", () => {
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
      frames: turns(toolCalls),
    });
    expect(finding!.citedRuns).toEqual([after.runId]);
    expect(finding!.windowStart).toEqual(since);
    expect(finding!.claims?.map((c) => c.runId)).toEqual([after.runId]);
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
    const toolCalls = shellRuns.flatMap((r) => [
      call(r, { at: 1, tool: "Bash", isMutating: true }),
      call(r, { at: 2, tool: "Bash", isMutating: true }),
    ]);
    const findings = detect({
      runs: [...shellRuns, cache],
      toolWindowStart,
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(findings.map((f) => f.kind)).toEqual([
      "cache_writes_never_read",
      "repeated_shell_commands",
    ]);
    expect(findings[0]!.windowStart).toEqual(START);
    expect(findings[1]!.windowStart).toEqual(toolWindowStart);
    expect(findings[1]!.citedRuns).toHaveLength(12);
    expect(findings[1]!.evidence.runs).toHaveLength(10);
    expect(findings[1]!.claims).toHaveLength(12);
  });

  it(`keeps at most ${FINDINGS_PER_KIND} findings of one kind, largest saving first`, () => {
    const r = run();
    const toolCalls = Array.from({ length: FINDINGS_PER_KIND + 2 }, (_, i) =>
      call(r, {
        at: i + 1,
        tool: `tool_${String(i).padStart(2, "0")}`,
        inputDigest: `in-${i}`,
        resultTokens: UNPAGED_RESULT_TOKENS + 1_000 * (i + 1),
      }),
    );
    const findings = detect({ runs: [r], toolCalls });
    expect(findings).toHaveLength(FINDINGS_PER_KIND);
    expect(findings[0]!.subject).toBe(`tool_${FINDINGS_PER_KIND + 1}`);
    expect(findings.map((f) => f.subject)).not.toContain("tool_00");
  });
});

describe("the frames a finding cites (#4001)", () => {
  const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";
  const bash = (r: RunTotalsRecord, at: number, sessionUuid?: string) =>
    call(r, {
      at,
      tool: "Bash",
      isMutating: true,
      sessionUuid: sessionUuid ?? null,
    });

  it("records each cited call of one run by its seq, across the run's turns", () => {
    const r = run();
    // The first call did the work; the repeats in two later turns are cited.
    const toolCalls = [bash(r, 1), bash(r, 40), bash(r, 5)];
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding?.evidence.frames).toEqual({
      [r.runId]: { seqs: [{ seq: "5" }, { seq: "40" }], total: 2 },
    });
  });

  it("names the subagent chain a cited call was recorded on", () => {
    const r = run();
    const toolCalls = [bash(r, 1), bash(r, 2, SUBAGENT)];
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding?.evidence.frames?.[r.runId]?.seqs).toEqual([
      { seq: "2", sessionUuid: SUBAGENT },
    ]);
  });

  it("stores the run's own frame before a subagent's at the same seq, whichever ran first", () => {
    // A seq is a position on its own chain, so the run and a subagent can
    // both cite seq 3. The subagent's call ran first here, so an order kept
    // from the calls would list it first.
    const r = run();
    const toolCalls = [
      bash(r, 1),
      { ...bash(r, 2, SUBAGENT), seq: 3 },
      bash(r, 3),
    ];
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding?.evidence.frames?.[r.runId]).toEqual({
      seqs: [{ seq: "3" }, { seq: "3", sessionUuid: SUBAGENT }],
      total: 2,
    });
  });

  it("stores no frames for a finding about a run's cache, which cites no call", () => {
    const r = run({
      cacheWriteMicros: 40_000n,
      tokens: { ...ZERO_TOKENS, input_uncached: 3_000, cache_write_5m: 8_000 },
    });
    const [finding] = detect({ runs: [r] });
    expect(finding?.kind).toBe("cache_writes_never_read");
    expect(finding?.evidence.frames).toBeUndefined();
  });

  it("caps the frames per run and counts every cited call in the total", () => {
    const r = run();
    const toolCalls = Array.from(
      { length: FINDING_FRAMES_PER_RUN + 10 },
      (_, i) => bash(r, i + 1),
    );
    const [finding] = detect({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    const cited = finding?.evidence.frames?.[r.runId];
    expect(cited?.seqs).toHaveLength(FINDING_FRAMES_PER_RUN);
    expect(cited?.seqs[0]).toEqual({ seq: "2" });
    expect(cited?.total).toBe(FINDING_FRAMES_PER_RUN + 9);
    // What the store holds parses as the contract's citation.
    expect(
      findingRunCitationSchema.safeParse({
        runId: r.runId,
        runLevel: false,
        frames: cited?.seqs,
        framesTotal: cited?.total,
      }).success,
    ).toBe(true);
  });

  it("cites frames in every cited run, past the ten the evidence itemises", () => {
    const runs = Array.from({ length: EVIDENCE_RUNS + 2 }, () => run());
    const toolCalls = runs.flatMap((r) => [bash(r, 1), bash(r, 2)]);
    const [finding] = detect({
      runs,
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(finding?.evidence.runs).toHaveLength(EVIDENCE_RUNS);
    expect(Object.keys(finding?.evidence.frames ?? {}).sort()).toEqual(
      runs.map((r) => r.runId).sort(),
    );
  });

  it("pins a cited call the counterfactual could not price", () => {
    const r = run();
    const [finding] = detect({
      runs: [r],
      toolCalls: [bash(r, 1), bash(r, 2), bash(r, 3), bash(r, 4)],
      frames: new Map([
        [
          r.runId,
          [request(r, 1), request(r, 2), request(r, 3), request(r, 4, null)],
        ],
      ]),
    });
    expect(finding?.evidence.coveredCalls).toBe(2);
    expect(finding?.evidence.frames?.[r.runId]?.total).toBe(3);
  });

  it("leaves a read-only repeat on a run with no agent or operator unclaimed, so a large one is still unpaged", () => {
    const r = run({ agentKey: null, operatorKey: null });
    const big = UNPAGED_RESULT_TOKENS + 1_000;
    const toolCalls = [
      call(r, { at: 1, resultTokens: big }),
      call(r, { at: 2, resultTokens: big }),
    ];
    // A third request re-reads the second result, so both results count.
    const frames = turns(toolCalls);
    frames.get(r.runId)!.push(request(r, 3));
    const findings = detect({ runs: [r], toolCalls, frames: priced(frames) });
    expect(
      findings.map((f) => [f.kind, f.evidence.frames?.[r.runId]?.total]),
    ).toEqual([["unpaged_results", 2]]);
  });
});

describe("countClaims", () => {
  const row = (
    detector: number,
    runId: string,
    frameKey: string,
    operatorKey: string | null,
    costMicros: bigint,
  ): ClaimRow => ({ detector, runId, frameKey, operatorKey, costMicros });

  it("counts a frame two detectors claim once, under the lower detector", () => {
    const spend = countClaims([
      row(8, "tse_a", "k#0", "prn_a", 40_000n),
      row(1, "tse_a", "k#0", "prn_a", 30_000n),
      row(7, "tse_a", "k#0", "prn_a", 35_000n),
      row(7, "tse_a", "k#1", "prn_a", 5_000n),
      row(1, "tse_b", "k#0", null, 7_000n),
      row(8, "tse_c", "k#0", "prn_b", 2_000n),
    ]);
    expect(spend).toEqual({
      totalMicros: 44_000n,
      operators: [
        { operatorKey: "prn_a", micros: 35_000n },
        { operatorKey: null, micros: 7_000n },
        { operatorKey: "prn_b", micros: 2_000n },
      ],
    });
  });

  it("sums the operator totals to the headline", () => {
    const spend = countClaims([
      row(1, "tse_a", "k#0", "prn_a", 11_000n),
      row(7, "tse_a", "k#0", "prn_a", 11_000n),
      row(1, "tse_b", "k#0", "prn_b", 11_000n),
      row(8, "tse_c", "k#0", null, 3_000n),
    ]);
    expect(spend.operators.reduce((sum, o) => sum + o.micros, 0n)).toBe(
      spend.totalMicros,
    );
    // Equal totals order by operator key.
    expect(spend.operators.map((o) => o.operatorKey)).toEqual([
      "prn_a",
      "prn_b",
      null,
    ]);
  });

  it("is zero with no operators when nothing is claimed", () => {
    expect(countClaims([])).toEqual({ totalMicros: 0n, operators: [] });
  });
});

describe("the limits the contracts carry", () => {
  it("keeps every open finding inside one list_findings answer", () => {
    expect(FINDINGS_MAX).toBeLessThanOrEqual(FINDINGS_LIST_MAX);
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
        name: null,
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
