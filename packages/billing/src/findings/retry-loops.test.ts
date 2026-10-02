import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import {
  detectInputFixture,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import {
  countClaims,
  detectFindings,
  RETRY_LOOP_CALLS,
  retryCalls,
  runsWithRetries,
  SPIN_LOOP_REPEATS,
  type DetectReads,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./index";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";
/** What one model request costs in these tests, and the tokens it carries. */
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;

let seq = 0;

function run(over: Partial<RunTotalsRecord> = {}): RunTotalsRecord {
  seq += 1;
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
    startedAt: new Date(FIXTURE_WINDOW_START.getTime() + seq * 3_600_000),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 1,
    tokens: { ...ZERO_TOKENS, input_uncached: 3_000 },
    costMicros: 9_000n,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
    ...over,
  };
}

/** A call `at` seconds into the run; by default a failing test command. */
function call(
  r: RunTotalsRecord,
  over: Omit<Partial<ToolCallObservation>, "at"> & { at: number },
): ToolCallObservation {
  return {
    runId: r.runId,
    seq: over.at,
    tool: "Bash",
    inputDigest: "pnpm-test",
    outputDigest: "",
    isMutating: true,
    resultTokens: null,
    sessionUuid: null,
    status: "error",
    errorClass: "Exit code 1",
    ...over,
    at: new Date(r.startedAt.getTime() + over.at * 1_000),
  };
}

/** One model request just before each call, so each call is its own turn. */
function turns(
  calls: readonly ToolCallObservation[],
): Map<string, PricedRequestFrame[]> {
  const out = new Map<string, PricedRequestFrame[]>();
  for (const c of calls) {
    const at = new Date(c.at.getTime() - 1);
    const list = out.get(c.runId) ?? [];
    list.push({
      key: `${at.toISOString()}#0`,
      at,
      costMicros: TURN_MICROS,
      tokens: TURN_TOKENS,
      basis: "gateway_observed",
      sessionUuid: c.sessionUuid,
    });
    out.set(c.runId, list);
  }
  return out;
}

/** A run's file changes, `at` seconds into it. */
function changes(r: RunTotalsRecord, ...at: number[]): number[] {
  return at.map((s) => (r.startedAt.getTime() + s * 1_000) * 1_000);
}

function detect(
  r: RunTotalsRecord,
  toolCalls: ToolCallObservation[],
  over: Partial<DetectReads> = {},
) {
  return detectFindings(
    detectInputFixture({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
      fileChangeTimes: { from: FIXTURE_WINDOW_START, byRun: new Map() },
      ...over,
    }),
  );
}

describe("retry loops", () => {
  it("prices the requests that only retried a call that failed 3 times in a row, and claims them as detector 1", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    const frames = turns(toolCalls);
    const drafts = detect(r, toolCalls, { frames });
    expect(RETRY_LOOP_CALLS).toBe(3);
    expect(drafts).toHaveLength(1);
    const [finding] = drafts;
    // The first call was the attempt. The two after it are the retries.
    expect(finding).toMatchObject({
      kind: "retry_loops",
      level: "agent",
      subject: AGENT,
      savingMicros: 2n * TURN_MICROS,
      citedRuns: [r.runId],
      confidence: "high",
    });
    expect(finding?.evidence.calls).toBe(2);
    expect(finding?.evidence.frames).toEqual({
      [r.runId]: { seqs: [{ seq: "2" }, { seq: "3" }], total: 2 },
    });
    const [, second, third] = frames.get(r.runId)!;
    expect(finding?.claims).toEqual([
      {
        detector: 1,
        runId: r.runId,
        frameKey: second!.key,
        frameAt: second!.at,
        operatorKey: OPERATOR,
        costMicros: TURN_MICROS,
      },
      {
        detector: 1,
        runId: r.runId,
        frameKey: third!.key,
        frameAt: third!.at,
        operatorKey: OPERATOR,
        costMicros: TURN_MICROS,
      },
    ]);
    expect(finding?.why).toBe(
      "On 1 run, a call failed 3 or more times in a row with the same error, and no write or file change came between the attempts. 2 calls came from turns that made only those retries.",
    );
    // #5023: the card names the call and how many times in a row it failed.
    expect(finding?.evidence.values).toEqual({
      kind: "retry_loops",
      tool: "Bash",
      failures: 3,
    });
  });

  // #5023: a turn that made several retries is priced once, and each of its
  // calls counts, so the card's number matches its calls label.
  it("prices a turn that made several retries once, and counts each of its calls", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    // One request made the attempt, and one more made both retries.
    const frames = turns(toolCalls.slice(0, 2));
    const [finding, ...rest] = detect(r, toolCalls, { frames });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "retry_loops",
      savingMicros: TURN_MICROS,
    });
    expect(finding?.evidence).toMatchObject({
      calls: 2,
      coveredCalls: 2,
      measuredTokens: TURN_TOKENS,
    });
    expect(finding?.evidence.frames).toEqual({
      [r.runId]: { seqs: [{ seq: "2" }, { seq: "3" }], total: 2 },
    });
    expect(finding?.claims).toHaveLength(1);
    expect(finding?.why).toContain(
      "2 calls came from turns that made only those retries.",
    );
  });

  it("stores the longest streak's tool and how many times in a row it failed (#5023)", () => {
    const r = run();
    const toolCalls = [
      ...[1, 2, 3].map((at) => call(r, { at })),
      // A different call ends the first streak, and a longer one follows.
      ...[4, 5, 6, 7, 8].map((at) =>
        call(r, { at, tool: "Read", inputDigest: "read-config" }),
      ),
    ];
    const [finding] = detect(r, toolCalls);
    expect(finding?.evidence.calls).toBe(6);
    expect(finding?.evidence.values).toEqual({
      kind: "retry_loops",
      tool: "Read",
      failures: 5,
    });
  });

  it("cites the run's operator when the run names no agent", () => {
    const r = run({ agentKey: null });
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    expect(detect(r, toolCalls)).toMatchObject([
      { kind: "retry_loops", level: "operator", subject: OPERATOR },
    ]);
  });

  it("finds no loop in 2 failures, a success, or a different error, input, or tool", () => {
    const r = run();
    const cases: ToolCallObservation[][] = [
      [call(r, { at: 1 }), call(r, { at: 2 })],
      [
        call(r, { at: 1 }),
        call(r, { at: 2 }),
        call(r, { at: 3, status: "ok", errorClass: null }),
      ],
      [
        call(r, { at: 1 }),
        call(r, { at: 2 }),
        call(r, { at: 3, errorClass: "Exit code 2" }),
      ],
      [
        call(r, { at: 1 }),
        call(r, { at: 2 }),
        call(r, { at: 3, inputDigest: "pnpm-test-fixed" }),
      ],
      [
        call(r, { at: 1 }),
        call(r, { at: 2 }),
        call(r, { at: 3, tool: "mcp__ci__run_tests" }),
      ],
    ];
    for (const toolCalls of cases) expect(detect(r, toolCalls)).toEqual([]);
  });

  it("finds no loop where the hook recorded no input or no error class", () => {
    const r = run();
    // A call with no recorded input or error may differ from the one before
    // it, so the hook's record cannot show the calls match.
    const noInput = [1, 2, 3].map((at) => call(r, { at, inputDigest: "" }));
    const noClass = [1, 2, 3].map((at) => call(r, { at, errorClass: null }));
    const emptyClass = [1, 2, 3].map((at) => call(r, { at, errorClass: "" }));
    expect(detect(r, noInput)).toEqual([]);
    expect(detect(r, noClass)).toEqual([]);
    expect(detect(r, emptyClass)).toEqual([]);
  });

  it("ends a streak at another call on its chain, or at a file change between two calls", () => {
    const r = run();
    const read = call(r, {
      at: 2.5,
      tool: "Read",
      inputDigest: "src/a.ts",
      isMutating: false,
      status: "ok",
      errorClass: null,
    });
    const interrupted = [
      call(r, { at: 1 }),
      call(r, { at: 2 }),
      read,
      call(r, { at: 3 }),
    ];
    expect(detect(r, interrupted)).toEqual([]);

    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    expect(
      detect(r, toolCalls, {
        fileChangeTimes: {
          from: FIXTURE_WINDOW_START,
          byRun: new Map([[r.runId, changes(r, 2.5)]]),
        },
      }),
    ).toEqual([]);
    // A file change before the streak changes nothing between its calls.
    expect(
      detect(r, toolCalls, {
        fileChangeTimes: {
          from: FIXTURE_WINDOW_START,
          byRun: new Map([[r.runId, changes(r, 0.5)]]),
        },
      }),
    ).toHaveLength(1);
  });

  it("ends a streak at a mutating call on another chain between two of its calls, and keeps it across a read-only one", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    const other = (isMutating: boolean | null) =>
      call(r, {
        at: 2.5,
        seq: 1,
        tool: "Edit",
        inputDigest: "src/a.ts",
        isMutating,
        status: "ok",
        errorClass: null,
        sessionUuid: SUBAGENT,
      });
    expect(detect(r, [...toolCalls, other(true)])).toEqual([]);
    // A call the classifier could not place may write.
    expect(detect(r, [...toolCalls, other(null)])).toEqual([]);
    expect(
      detect(r, [...toolCalls, other(false)]).map((d) => d.kind),
    ).toEqual(["retry_loops"]);
  });

  it("counts each chain on its own, so two subagents failing once each are not a loop", () => {
    const r = run();
    const chainA = "00000000-0000-4000-8000-0000000000c1";
    const chainB = "00000000-0000-4000-8000-0000000000c2";
    const toolCalls = [
      call(r, { at: 1, seq: 1, sessionUuid: chainA }),
      call(r, { at: 2, seq: 1, sessionUuid: chainB }),
      call(r, { at: 3, seq: 2, sessionUuid: chainA }),
    ];
    expect(retryCalls(toolCalls, [], FIXTURE_WINDOW_START).size).toBe(0);
  });

  it("writes nothing when the pass read no file changes, since no streak can be shown to have none", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    const input = detectInputFixture({
      runs: [r],
      toolCalls,
      frames: turns(toolCalls),
    });
    expect(input.fileChangeTimes).toBeUndefined();
    expect(detectFindings(input)).toEqual([]);
  });

  it("treats a pair of calls before the file change read began as broken", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    const capped = new Date(r.startedAt.getTime() + 2_500);
    // The read covers only the third call: the first two pairs start before it.
    expect(retryCalls(toolCalls, [], capped).size).toBe(0);
    expect(retryCalls(toolCalls, [], FIXTURE_WINDOW_START).size).toBe(2);
  });

  it("counts a request only when every call it made is a retry", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    // The third request also made a new read, so only the second counts.
    const read = call(r, {
      at: 3,
      seq: 3.5,
      tool: "Read",
      inputDigest: "src/a.ts",
      isMutating: false,
      status: "ok",
      errorClass: null,
      sessionUuid: SUBAGENT,
    });
    const frames = turns(toolCalls);
    const [finding] = detect(r, [...toolCalls, read], { frames });
    expect(finding).toMatchObject({
      kind: "retry_loops",
      savingMicros: TURN_MICROS,
    });
    expect(finding?.claims?.map((c) => c.frameKey)).toEqual([
      frames.get(r.runId)![1]!.key,
    ]);
  });

  it("writes no priced finding for the retries of a run whose frames were not read", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) => call(r, { at }));
    expect(detect(r, toolCalls, { frames: new Map() })).toEqual([]);
  });

  it("ranks a run with retries for the frame read", () => {
    const r = run();
    const toolCalls = [1, 2, 3, 4].map((at) => call(r, { at }));
    expect(runsWithRetries(toolCalls, undefined)).toEqual(
      new Map([[r.runId, 3]]),
    );
    expect(runsWithRetries(toolCalls.slice(0, 2), undefined)).toEqual(
      new Map(),
    );
  });
});

describe("retry loops beside the other detector 1 kinds", () => {
  it("leaves a frame spin loops claimed to spin loops, so it counts once", () => {
    const r = run();
    // The same failing command, with the same recorded output each time, run
    // past the spin loop threshold: every call after the first is a repeat
    // and a retry.
    const toolCalls = Array.from({ length: SPIN_LOOP_REPEATS + 1 }, (_, i) =>
      call(r, { at: i + 1, outputDigest: "exit-1-output" }),
    );
    const drafts = detect(r, toolCalls);
    expect(drafts.map((d) => d.kind)).toEqual(["spin_loops"]);
    const claims = drafts.flatMap((d) => d.claims ?? []);
    expect(claims).toHaveLength(SPIN_LOOP_REPEATS);
    expect(
      countClaims(
        claims.map((c) => ({
          detector: c.detector,
          runId: c.runId,
          frameKey: c.frameKey,
          operatorKey: c.operatorKey,
          costMicros: c.costMicros,
        })),
      ).totalMicros,
    ).toBe(BigInt(SPIN_LOOP_REPEATS) * TURN_MICROS);
  });

  it("claims a retry before repeated shell commands can, so the request counts once", () => {
    const r = run();
    const toolCalls = [1, 2, 3].map((at) =>
      call(r, { at, outputDigest: "exit-1-output" }),
    );
    const drafts = detect(r, toolCalls);
    expect(drafts.map((d) => d.kind)).toEqual(["retry_loops"]);
    expect(drafts[0]?.claims).toHaveLength(2);
  });

  it("leaves a request that repeated a successful read to duplicate tool calls", () => {
    const r = run();
    const read = (at: number) =>
      call(r, {
        at,
        tool: "Read",
        inputDigest: "src/a.ts",
        outputDigest: "src-a",
        isMutating: false,
        status: "ok",
        errorClass: null,
      });
    const toolCalls = [read(1), read(2), read(3)];
    expect(detect(r, toolCalls).map((d) => d.kind)).toEqual([
      "duplicate_tool_calls",
    ]);
  });
});
