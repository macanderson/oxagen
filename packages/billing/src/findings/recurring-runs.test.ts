import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import { blankOutcome, type OutcomeRow } from "../run-pr-outcomes";
import {
  detectInputFixture,
  FIXTURE_WINDOW_END,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import {
  DETECTORS,
  detectFindings,
  Groups,
  SPIN_LOOP_REPEATS,
  type DetectContext,
  type DetectInput,
  type DetectReads,
  type FindingDraft,
  type PricedRequestFrame,
  type RunFirstPrompt,
  type ToolCallObservation,
} from "./index";
import {
  RECURRING_RUNS_MIN,
  recurringRuns,
  runChange,
} from "./recurring-runs";
import { claimKey } from "./requests";
import { spendWithNoOutcome } from "./spend-with-no-outcome";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Every run the builder makes starts after this, two days into the window. */
const RUNS_FROM = new Date(FIXTURE_WINDOW_START.getTime() + 2 * DAY_MS);
const DIGEST = "sha256:nightly-triage";
const WHY_TAIL =
  "A run changed nothing when it made no mutating call and changed no file.";

let seq = 0;

/** A sealed run, ten minutes long, with three model calls and no tool call. */
function run(over: Partial<RunTotalsRecord> = {}): RunTotalsRecord {
  seq += 1;
  const startedAt = new Date(RUNS_FROM.getTime() + seq * 60 * 60_000);
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
    startedAt,
    sealedAt: new Date(startedAt.getTime() + 10 * 60_000),
    turns: 3,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 3,
    modelCalls: 3,
    toolCalls: 0,
    tokens: { ...ZERO_TOKENS, input_uncached: 12_000 },
    costMicros: 3n * TURN_MICROS,
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

/** `n` runs of one job. */
function job(
  n: number,
  over: Partial<RunTotalsRecord> = {},
): RunTotalsRecord[] {
  return Array.from({ length: n }, () => run(over));
}

/** A model request `at` milliseconds into the run, keyed the way the store keys it. */
function frameAt(r: RunTotalsRecord, at: number): PricedRequestFrame {
  const time = new Date(r.startedAt.getTime() + at);
  return {
    key: `${time.toISOString()}#0`,
    at: time,
    costMicros: TURN_MICROS,
    tokens: TURN_TOKENS,
    basis: "gateway_observed",
  };
}

/** Three model requests, one a second from the run's start. */
function framesOf(r: RunTotalsRecord): PricedRequestFrame[] {
  return [1, 2, 3].map((i) => frameAt(r, i * 1_000));
}

/** One tool call `i` seconds into the run. */
function callOf(
  r: RunTotalsRecord,
  i: number,
  over: Partial<ToolCallObservation> = {},
): ToolCallObservation {
  return {
    runId: r.runId,
    at: new Date(r.startedAt.getTime() + i * 1_000),
    seq: i,
    tool: "Read",
    inputDigest: `in-${i}`,
    outputDigest: `out-${i}`,
    isMutating: false,
    resultTokens: 200,
    sessionUuid: null,
    ...over,
  };
}

function firstPrompt(r: RunTotalsRecord, digest: string): RunFirstPrompt {
  return {
    at: r.startedAt,
    atMicros: r.startedAt.getTime() * 1000,
    digest,
    source: null,
    origin: null,
    commandName: null,
  };
}

/**
 * The reads for runs grouped by digest: each run's first prompt, no file
 * change, and three priced frames.
 */
function reads(
  jobs: Record<string, readonly RunTotalsRecord[]>,
  over: Partial<DetectReads> = {},
): DetectReads {
  const runs = Object.values(jobs).flat();
  const firstPrompts = new Map<string, RunFirstPrompt>();
  for (const [digest, list] of Object.entries(jobs))
    for (const r of list) firstPrompts.set(r.runId, firstPrompt(r, digest));
  return detectInputFixture({
    runs,
    firstPrompts,
    fileChanges: new Map(runs.map((r) => [r.runId, false])),
    frames: new Map(runs.map((r) => [r.runId, framesOf(r)])),
    ...over,
  });
}

function recurring(findings: readonly FindingDraft[]): FindingDraft[] {
  return findings.filter((f) => f.kind === "recurring_runs");
}

describe("recurring runs", () => {
  it("writes one finding for a prompt that started 5 runs that changed nothing", () => {
    const runs = job(RECURRING_RUNS_MIN);
    const findings = detectFindings(reads({ [DIGEST]: runs }));
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toMatchObject({
      kind: "recurring_runs",
      level: "agent",
      subject: AGENT,
      savingMicros: 5n * 3n * TURN_MICROS,
      confidence: "high",
      why: `5 runs started with the same prompt in the last 30 days. 5 of them changed nothing. ${WHY_TAIL}`,
    });
    expect(finding!.fix).toContain("instead of on a clock");
    expect([...finding!.citedRuns].sort()).toEqual(runs.map((r) => r.runId));
    expect(finding!.evidence).toMatchObject({ calls: 15, coveredCalls: 15 });
    expect(finding!.evidence.frames).toBeUndefined();
    expect(finding!.claims).toHaveLength(15);
    expect(new Set(finding!.claims!.map((c) => c.detector))).toEqual(
      new Set([7]),
    );
    expect(finding!.claims!.map((c) => c.frameKey)).toEqual(
      expect.arrayContaining(
        runs.flatMap((r) => framesOf(r).map((f) => f.key)),
      ),
    );
  });

  it("writes nothing for a prompt that started 4 runs", () => {
    const runs = job(RECURRING_RUNS_MIN - 1);
    expect(detectFindings(reads({ [DIGEST]: runs }))).toEqual([]);
  });

  it("counts runs by their first prompt's digest, not by agent", () => {
    const runs = job(3);
    const others = job(3);
    expect(
      detectFindings(reads({ [DIGEST]: runs, "sha256:other": others })),
    ).toEqual([]);
  });

  it("does not cite a run that changed a file or made a mutating call", () => {
    const quiet = job(5);
    const wrote = run();
    const pushed = run({ toolCalls: 1 });
    const input = reads(
      { [DIGEST]: [...quiet, wrote, pushed] },
      { toolCalls: [callOf(pushed, 1, { tool: "Bash", isMutating: true })] },
    );
    const fileChanges = new Map(input.fileChanges);
    fileChanges.set(wrote.runId, true);
    const [finding, ...rest] = recurring(
      detectFindings({ ...input, fileChanges }),
    );
    expect(rest).toEqual([]);
    expect(finding!.why).toBe(
      `7 runs started with the same prompt in the last 30 days. 5 of them changed nothing. ${WHY_TAIL}`,
    );
    expect(finding!.citedRuns).not.toContain(wrote.runId);
    expect(finding!.citedRuns).not.toContain(pushed.runId);
    expect(finding!.savingMicros).toBe(5n * 3n * TURN_MICROS);
  });

  it("cites a run that changed nothing and read only calls that change nothing", () => {
    const runs = job(5, { toolCalls: 2 });
    const toolCalls = runs.flatMap((r) => [callOf(r, 1), callOf(r, 2)]);
    const found = recurring(
      detectFindings(reads({ [DIGEST]: runs }, { toolCalls })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.citedRuns).toHaveLength(5);
  });

  interface UnknownCase {
    name: string;
    run: () => RunTotalsRecord;
    calls?: (r: RunTotalsRecord) => ToolCallObservation[];
    noFileEntry?: boolean;
  }

  const TOOL_WINDOW_START = new Date(FIXTURE_WINDOW_START.getTime() + DAY_MS);

  const unknownCases: UnknownCase[] = [
    {
      name: "it started before the tool-call read began",
      run: () => {
        const startedAt = new Date(FIXTURE_WINDOW_START.getTime() + HOUR_MS);
        return run({
          startedAt,
          sealedAt: new Date(startedAt.getTime() + 10 * 60_000),
        });
      },
    },
    {
      name: "the classifier said nothing about a call",
      run: () => run({ toolCalls: 1 }),
      calls: (r) => [callOf(r, 1, { isMutating: null })],
    },
    { name: "it had not sealed", run: () => run({ sealedAt: null }) },
    {
      name: "it sealed at the window's end",
      run: () => run({ sealedAt: FIXTURE_WINDOW_END }),
    },
    {
      name: "the read saw fewer calls than the rollup counted",
      run: () => run({ toolCalls: 2 }),
      calls: (r) => [callOf(r, 1)],
    },
    {
      name: "the file change read has no entry for it",
      run: () => run(),
      noFileEntry: true,
    },
  ];

  it.each(unknownCases)(
    "cites a run where $name, and prices none of it",
    (c) => {
      const quiet = job(5);
      const unknown = c.run();
      const input = reads(
        { [DIGEST]: [...quiet, unknown] },
        {
          toolWindowStart: TOOL_WINDOW_START,
          toolCalls: c.calls?.(unknown) ?? [],
        },
      );
      const fileChanges = new Map(input.fileChanges);
      if (c.noFileEntry) fileChanges.delete(unknown.runId);
      const [finding, ...rest] = recurring(
        detectFindings({ ...input, fileChanges }),
      );
      expect(rest).toEqual([]);
      expect(finding!.citedRuns).toContain(unknown.runId);
      expect(finding!.evidence).toMatchObject({ calls: 16, coveredCalls: 15 });
      expect(finding!.savingMicros).toBe(5n * 3n * TURN_MICROS);
      expect(
        finding!.claims!.filter((claim) => claim.runId === unknown.runId),
      ).toEqual([]);
      // The run is counted among the runs the prompt started, not among the
      // runs that changed nothing.
      expect(finding!.why).toBe(
        `6 runs started with the same prompt in the last 30 days. 5 of them changed nothing. ${WHY_TAIL}`,
      );
    },
  );

  it("takes a known change over a gap in the reads", () => {
    const r = run({ sealedAt: null });
    const input = reads({ [DIGEST]: [r] });
    expect(runChange(r, [], input, new Map([[r.runId, true]]))).toBe(
      "changed",
    );
    expect(
      runChange(
        r,
        [callOf(r, 1, { isMutating: true })],
        input,
        new Map([[r.runId, false]]),
      ),
    ).toBe("changed");
    expect(runChange(r, [], input, new Map([[r.runId, false]]))).toBe(
      "unknown",
    );
  });

  it("cites a run whose frames were not read, and prices none of it", () => {
    const runs = job(6);
    const unread = runs[5]!;
    const input = reads({ [DIGEST]: runs });
    const frames = new Map(input.frames);
    frames.delete(unread.runId);
    const [finding] = detectFindings({ ...input, frames });
    expect(finding!.citedRuns).toContain(unread.runId);
    expect(finding!.evidence).toMatchObject({ calls: 16, coveredCalls: 15 });
    expect(finding!.why).toBe(
      `6 runs started with the same prompt in the last 30 days. 6 of them changed nothing. ${WHY_TAIL}`,
    );
  });

  it("leaves out a run whose rollup counted no model call", () => {
    const runs = job(5);
    const idle = run({ modelCalls: 0, costMicros: 0n });
    const input = reads({ [DIGEST]: [...runs, idle] });
    const frames = new Map(input.frames);
    frames.delete(idle.runId);
    const [finding] = detectFindings({ ...input, frames });
    expect(finding!.citedRuns).not.toContain(idle.runId);
    expect(finding!.evidence).toMatchObject({ calls: 15, coveredCalls: 15 });
  });

  it("does not count again a frame spin loops claimed as detector 1", () => {
    const looping = run({ toolCalls: SPIN_LOOP_REPEATS + 1 });
    const toolCalls = Array.from({ length: SPIN_LOOP_REPEATS + 1 }, (_, i) =>
      callOf(looping, i + 1, {
        tool: "mcp__slack__list_channels",
        inputDigest: "in-1",
        outputDigest: "out-1",
        resultTokens: 5_000,
      }),
    );
    // One request just before each call, then two that made no call.
    const callFrames = toolCalls.map((c) =>
      frameAt(looping, c.at.getTime() - looping.startedAt.getTime() - 1),
    );
    const extra = [frameAt(looping, 60_000), frameAt(looping, 61_000)];
    const quiet = job(4);
    const input = reads({ [DIGEST]: [looping, ...quiet] }, { toolCalls });
    const frames = new Map(input.frames);
    frames.set(looping.runId, [...callFrames, ...extra]);
    const findings = detectFindings({ ...input, frames });
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "recurring_runs",
      "spin_loops",
    ]);
    const spin = findings.find((f) => f.kind === "spin_loops")!;
    const [recurringFinding] = recurring(findings);
    const spinKeys = spin.claims!.map((c) => c.frameKey);
    expect(spinKeys).toHaveLength(SPIN_LOOP_REPEATS);
    const loopClaims = recurringFinding!.claims!.filter(
      (c) => c.runId === looping.runId,
    );
    expect(loopClaims.map((c) => [c.detector, c.frameKey])).toEqual([
      [7, callFrames[0]!.key],
      [7, extra[0]!.key],
      [7, extra[1]!.key],
    ]);
    for (const key of spinKeys)
      expect(loopClaims.map((c) => c.frameKey)).not.toContain(key);
    expect(recurringFinding!.savingMicros).toBe(
      3n * TURN_MICROS + 4n * 3n * TURN_MICROS,
    );
  });

  it("skips a frame an earlier detector claimed this pass", () => {
    const runs = job(5);
    const input = reads({ [DIGEST]: runs });
    const taken = input.frames.get(runs[0]!.runId)![0]!;
    const ctx: DetectContext = {
      groups: new Groups(new Map()),
      runs: new Map(runs.map((r) => [r.runId, r])),
      views: [],
      claimed: new Set([claimKey(runs[0]!.runId, taken.key)]),
      taken: new Set(),
    };
    recurringRuns.detect(input, ctx);
    const [group] = [...ctx.groups.values()];
    expect(group!.covered).toBe(14);
    expect(group!.claims.map((c) => c.frameKey)).not.toContain(taken.key);
    expect(group!.claims.every((c) => c.detector === 7)).toBe(true);
    const last = input.frames.get(runs[4]!.runId)![2]!;
    expect(ctx.claimed.has(claimKey(runs[4]!.runId, last.key))).toBe(true);
  });

  it("claims its frames before spend with no outcome can", () => {
    const runs = job(5);
    const lone = run();
    const closed = (r: RunTotalsRecord): OutcomeRow => ({
      ...blankOutcome(r.runId, "tacho", {
        provider: "github",
        repository: "acme/core",
        number: 1,
        url: null,
      }),
      prState: "closed",
      closedAt: new Date(r.startedAt.getTime() + DAY_MS),
      prStateReadAt: FIXTURE_WINDOW_END,
    });
    const outcomes = new Map(
      [...runs, lone].map((r) => [r.runId, [closed(r)]]),
    );
    const findings = detectFindings(
      reads({ [DIGEST]: runs, "sha256:once": [lone] }, { outcomes }),
    );
    expect(findings.map((f) => f.kind)).toEqual([
      "recurring_runs",
      "spend_with_no_outcome",
    ]);
    const [recurringFinding, noOutcome] = findings;
    expect(recurringFinding!.citedRuns).toHaveLength(5);
    expect(recurringFinding!.savingMicros).toBe(5n * 3n * TURN_MICROS);
    // Every run's pull request closed unmerged, and detector 8 counts only the
    // run no recurring prompt started.
    expect(noOutcome!.citedRuns).toEqual([lone.runId]);
    expect(noOutcome!.claims!.map((c) => c.detector)).toEqual([8, 8, 8]);
  });

  it("reports under the agent every run names, else the operator, else the workspace", () => {
    const agentRuns = job(5);
    const operatorRuns = job(5, { agentKey: null });
    const mixed = [...job(3), ...job(2, { agentKey: "acme.core.review" })];
    const findings = detectFindings(
      reads({
        "sha256:agent": agentRuns,
        "sha256:operator": operatorRuns,
        "sha256:mixed": mixed,
      }),
    );
    expect(findings.map((f) => [f.level, f.subject]).sort()).toEqual([
      ["agent", AGENT],
      ["operator", OPERATOR],
      ["workspace", WS],
    ]);
  });

  it("reports one agent's recurring prompts in one finding and names the others", () => {
    const nightly = job(6);
    const hourly = job(5);
    const findings = detectFindings(
      reads({ [DIGEST]: nightly, "sha256:hourly": hourly }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.citedRuns).toHaveLength(11);
    expect(findings[0]!.why).toBe(
      `6 runs started with the same prompt in the last 30 days. 6 of them changed nothing. 1 other prompt also started 5 or more runs each, and 5 runs of those changed nothing. ${WHY_TAIL}`,
    );
  });

  it("adds nothing from a prompt whose runs are all unknown to another prompt's finding", () => {
    const nightly = job(5);
    const hourly = job(5, { sealedAt: null });
    const findings = detectFindings(
      reads({ [DIGEST]: nightly, "sha256:hourly": hourly }),
    );
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect([...finding!.citedRuns].sort()).toEqual(
      nightly.map((r) => r.runId),
    );
    expect(finding!.evidence).toMatchObject({ calls: 15, coveredCalls: 15 });
    expect(finding!.why).toBe(
      `5 runs started with the same prompt in the last 30 days. 5 of them changed nothing. ${WHY_TAIL}`,
    );
  });

  it("counts only runs that started after a person decided the finding", () => {
    const runs = job(7);
    const decided = new Date(
      (runs[1]!.startedAt.getTime() + runs[2]!.startedAt.getTime()) / 2,
    );
    const decidedSince = new Map([[`recurring_runs|agent|${AGENT}`, decided]]);
    const [finding] = detectFindings(
      reads({ [DIGEST]: runs }, { decidedSince }),
    );
    expect([...finding!.citedRuns].sort()).toEqual(
      runs.slice(2).map((r) => r.runId),
    );
    expect(finding!.windowStart).toEqual(decided);

    const later = new Date(
      (runs[2]!.startedAt.getTime() + runs[3]!.startedAt.getTime()) / 2,
    );
    expect(
      detectFindings(
        reads(
          { [DIGEST]: runs },
          {
            decidedSince: new Map([[`recurring_runs|agent|${AGENT}`, later]]),
          },
        ),
      ),
    ).toEqual([]);
  });

  it("writes nothing when the pass read no first prompts", () => {
    const runs = job(5);
    const input: DetectInput = {
      window: { start: FIXTURE_WINDOW_START, end: FIXTURE_WINDOW_END },
      toolWindowStart: FIXTURE_WINDOW_START,
      runs,
      toolCalls: [],
      decidedSince: new Map(),
      fileChanges: new Map(runs.map((r) => [r.runId, false])),
      frames: new Map(runs.map((r) => [r.runId, framesOf(r)])),
    };
    expect(detectFindings(input)).toEqual([]);
  });

  it("never groups a ledger run, which records no prompt", () => {
    const runs = job(5, { runSource: "ledger" });
    const input = reads({ [DIGEST]: runs });
    expect(
      detectFindings({
        ...input,
        firstPrompts: new Map(),
        fileChanges: new Map(),
      }),
    ).toEqual([]);
  });
});

describe("the detector registry", () => {
  it("runs recurring runs after every detector that claims as 1, and before spend with no outcome", () => {
    const at = DETECTORS.indexOf(recurringRuns);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(recurringRuns.counting).toBe(7);
    DETECTORS.forEach((d, i) => {
      if (d.counting === 1) expect(i).toBeLessThan(at);
    });
    expect(at).toBeLessThan(DETECTORS.indexOf(spendWithNoOutcome));
  });
});
