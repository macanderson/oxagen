import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import { blankOutcome, type OutcomeRow } from "../run-pr-outcomes";
import {
  DETECTORS,
  detectFindings,
  Groups,
  SPIN_LOOP_REPEATS,
  type DetectContext,
  type DetectInput,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./index";
import { claimKey } from "./requests";
import {
  noOutcomeReason,
  REVERT_WINDOW_DAYS,
  spendWithNoOutcome,
} from "./spend-with-no-outcome";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MERGED_AT = new Date("2026-08-20T12:00:00.000Z");
const READ_AT = new Date("2026-09-14T00:00:00.000Z");

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
    startedAt: new Date(START.getTime() + seq * 60_000),
    sealedAt: null,
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

/** A model request `at` milliseconds into the run, keyed the way the store keys it. */
function frameAt(
  r: RunTotalsRecord,
  at: number,
  costMicros: bigint | null = TURN_MICROS,
): PricedRequestFrame {
  const time = new Date(r.startedAt.getTime() + at);
  return {
    key: `${time.toISOString()}#0`,
    at: time,
    costMicros,
    tokens: TURN_TOKENS,
    basis: costMicros === null ? null : "gateway_observed",
  };
}

/** `n` model requests, one a second from the run's start. */
function framesOf(
  r: RunTotalsRecord,
  n = 3,
  costMicros: bigint | null = TURN_MICROS,
): PricedRequestFrame[] {
  return Array.from({ length: n }, (_, i) =>
    frameAt(r, (i + 1) * 1_000, costMicros),
  );
}

/** A pull request the run opened, with its state read. */
function pr(
  r: RunTotalsRecord,
  over: Partial<OutcomeRow>,
  number = 1,
): OutcomeRow {
  return {
    ...blankOutcome(r.runId, "tacho", {
      provider: "github",
      repository: "acme/core",
      number,
      url: null,
    }),
    prStateReadAt: READ_AT,
    ...over,
  };
}

const closedUnmerged = (r: RunTotalsRecord, number = 1) =>
  pr(r, { prState: "closed", closedAt: MERGED_AT }, number);

const merged = (
  r: RunTotalsRecord,
  over: Partial<OutcomeRow> = {},
  number = 1,
) =>
  pr(
    r,
    {
      prState: "merged",
      merged: true,
      mergedAt: MERGED_AT,
      closedAt: MERGED_AT,
      ...over,
    },
    number,
  );

/** A merged pull request a revert undid `days` after the merge. */
const revertedAfter = (r: RunTotalsRecord, days: number, number = 1) =>
  merged(
    r,
    {
      reverted: true,
      revertedBy: "github:acme/core#99",
      revertedAt: new Date(MERGED_AT.getTime() + days * DAY_MS),
      revertedReadAt: READ_AT,
    },
    number,
  );

/** The `none` row of a run that opened no pull request. */
function noPr(
  r: RunTotalsRecord,
  terminalReason: string | null,
  readAt: Date | null = READ_AT,
): OutcomeRow {
  return {
    ...blankOutcome(r.runId, "tacho", null),
    terminalReason,
    terminalReasonReadAt: readAt,
  };
}

function byRun(rows: readonly OutcomeRow[]): Map<string, OutcomeRow[]> {
  const out = new Map<string, OutcomeRow[]>();
  for (const row of rows)
    out.set(row.runId, [...(out.get(row.runId) ?? []), row]);
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

/** One run with three priced frames and the given outcome rows. */
function detectOne(r: RunTotalsRecord, rows: readonly OutcomeRow[]) {
  return detect({
    runs: [r],
    outcomes: byRun(rows),
    frames: new Map([[r.runId, framesOf(r)]]),
  });
}

describe("noOutcomeReason", () => {
  it("names a pull request that closed unmerged", () => {
    const r = run();
    expect(noOutcomeReason([closedUnmerged(r)])).toBe("closed_unmerged");
  });

  it(`names a revert within ${REVERT_WINDOW_DAYS} days of the merge, the last day included`, () => {
    const r = run();
    expect(noOutcomeReason([revertedAfter(r, 3)])).toBe("reverted");
    expect(noOutcomeReason([revertedAfter(r, REVERT_WINDOW_DAYS)])).toBe(
      "reverted",
    );
  });

  it("keeps the merged outcome for a later revert, or one with no time", () => {
    const r = run();
    expect(noOutcomeReason([revertedAfter(r, 20)])).toBeNull();
    expect(noOutcomeReason([revertedAfter(r, REVERT_WINDOW_DAYS + 1)])).toBe(
      null,
    );
    expect(
      noOutcomeReason([
        merged(r, { reverted: true, revertedAt: null, revertedReadAt: READ_AT }),
      ]),
    ).toBeNull();
    expect(noOutcomeReason([merged(r)])).toBeNull();
  });

  it("is null while a pull request is unread or open", () => {
    const r = run();
    expect(noOutcomeReason([])).toBeNull();
    expect(noOutcomeReason([pr(r, { prStateReadAt: null })])).toBeNull();
    expect(noOutcomeReason([pr(r, { prState: "open" })])).toBeNull();
    expect(
      noOutcomeReason([closedUnmerged(r, 1), pr(r, { prState: "open" }, 2)]),
    ).toBeNull();
  });

  it("is null when any pull request of the run landed", () => {
    const r = run();
    expect(noOutcomeReason([closedUnmerged(r, 1), merged(r, {}, 2)])).toBe(
      null,
    );
  });

  it("names the revert when a run has a reverted and a closed pull request", () => {
    const r = run();
    expect(
      noOutcomeReason([closedUnmerged(r, 1), revertedAfter(r, 2, 2)]),
    ).toBe("reverted");
  });

  it("names a run with no pull request only when its terminal reason says abandoned", () => {
    const r = run();
    expect(noOutcomeReason([noPr(r, "abandoned")])).toBe("abandoned");
    expect(noOutcomeReason([noPr(r, "completed")])).toBeNull();
    expect(noOutcomeReason([noPr(r, null)])).toBeNull();
    expect(noOutcomeReason([noPr(r, "abandoned", null)])).toBeNull();
  });
});

describe("spend with no outcome", () => {
  it("finds a run whose pull request was reverted, prices each frame, and claims it as detector 8", () => {
    const r = run();
    const findings = detectOne(r, [revertedAfter(r, 3)]);
    expect(findings.map((f) => f.kind)).toEqual(["spend_with_no_outcome"]);
    const [finding] = findings;
    expect(finding).toMatchObject({
      level: "agent",
      subject: AGENT,
      savingMicros: 3n * TURN_MICROS,
      confidence: "high",
      citedRuns: [r.runId],
    });
    expect(finding!.evidence.frames).toBeUndefined();
    expect(finding!.claims).toEqual(
      framesOf(r).map((f) => ({
        detector: 8,
        runId: r.runId,
        frameKey: f.key,
        frameAt: f.at,
        operatorKey: OPERATOR,
        costMicros: TURN_MICROS,
      })),
    );
    expect(finding!.why).toContain("1 run ended with nothing kept.");
    expect(finding!.why).not.toMatch(/waste|session|trace/i);
    expect(finding!.fix).not.toMatch(/waste|session|trace/i);
  });

  it("finds a run whose pull request closed unmerged", () => {
    const r = run();
    const findings = detectOne(r, [closedUnmerged(r)]);
    expect(findings.map((f) => [f.kind, f.savingMicros])).toEqual([
      ["spend_with_no_outcome", 3n * TURN_MICROS],
    ]);
  });

  it("yields none for a pull request reverted 20 days after it merged", () => {
    const r = run();
    expect(detectOne(r, [revertedAfter(r, 20)])).toEqual([]);
  });

  it("yields none while the outcome is unread or the pull request is open", () => {
    const unread = run();
    const open = run();
    const unlisted = run();
    const findings = detect({
      runs: [unread, open, unlisted],
      outcomes: byRun([
        pr(unread, { prStateReadAt: null }),
        pr(open, { prState: "open" }),
      ]),
      frames: new Map(
        [unread, open, unlisted].map((r) => [r.runId, framesOf(r)]),
      ),
    });
    expect(findings).toEqual([]);
  });

  it("yields none when the pass reads no outcomes", () => {
    const r = run();
    expect(
      detect({ runs: [r], frames: new Map([[r.runId, framesOf(r)]]) }),
    ).toEqual([]);
  });

  it("finds a run that opened no pull request and was abandoned", () => {
    const r = run();
    const findings = detectOne(r, [noPr(r, "abandoned")]);
    expect(findings.map((f) => f.kind)).toEqual(["spend_with_no_outcome"]);
    const completed = run();
    expect(detectOne(completed, [noPr(completed, "completed")])).toEqual([]);
  });

  it(`does not count again a frame spin loops claimed as detector 1`, () => {
    const r = run();
    const toolCalls: ToolCallObservation[] = Array.from(
      { length: SPIN_LOOP_REPEATS + 1 },
      (_, i) => ({
        runId: r.runId,
        at: new Date(r.startedAt.getTime() + (i + 1) * 1_000),
        seq: i + 1,
        tool: "mcp__slack__list_channels",
        inputDigest: "in-1",
        outputDigest: "out-1",
        isMutating: false,
        resultTokens: 5_000,
        sessionUuid: null,
      }),
    );
    // One request just before each call, then two that made no call.
    const callFrames = toolCalls.map((c) =>
      frameAt(r, c.at.getTime() - r.startedAt.getTime() - 1),
    );
    const extra = [frameAt(r, 60_000), frameAt(r, 61_000)];
    const findings = detect({
      runs: [r],
      toolCalls,
      outcomes: byRun([closedUnmerged(r)]),
      frames: new Map([[r.runId, [...callFrames, ...extra]]]),
    });
    expect(findings.map((f) => f.kind)).toEqual([
      "spin_loops",
      "spend_with_no_outcome",
    ]);
    const [spin, noOutcome] = findings;
    const spinKeys = spin!.claims!.map((c) => c.frameKey);
    expect(spinKeys).toHaveLength(SPIN_LOOP_REPEATS);
    expect(noOutcome!.claims!.map((c) => [c.detector, c.frameKey])).toEqual([
      [8, callFrames[0]!.key],
      [8, extra[0]!.key],
      [8, extra[1]!.key],
    ]);
    expect(noOutcome!.savingMicros).toBe(3n * TURN_MICROS);
    for (const key of spinKeys)
      expect(noOutcome!.claims!.map((c) => c.frameKey)).not.toContain(key);
  });

  it("skips a frame an earlier detector claimed this pass, such as detector 7", () => {
    const r = run();
    const frames = framesOf(r);
    const input: DetectInput = {
      window: { start: START, end: END },
      toolWindowStart: START,
      runs: [r],
      toolCalls: [],
      decidedSince: new Map(),
      outcomes: byRun([closedUnmerged(r)]),
      frames: new Map([[r.runId, frames]]),
    };
    const ctx: DetectContext = {
      groups: new Groups(new Map()),
      runs: new Map([[r.runId, r]]),
      views: [],
      claimed: new Set([claimKey(r.runId, frames[0]!.key)]),
      taken: new Set(),
    };
    spendWithNoOutcome.detect(input, ctx);
    const [group] = [...ctx.groups.values()];
    expect(group!.covered).toBe(2);
    expect(group!.claims.map((c) => c.frameKey)).toEqual([
      frames[1]!.key,
      frames[2]!.key,
    ]);
    expect(ctx.claimed.has(claimKey(r.runId, frames[2]!.key))).toBe(true);
  });

  it("cites a run whose frames were not read, and prices none of it", () => {
    const unread = run();
    expect(
      detect({
        runs: [unread],
        outcomes: byRun([closedUnmerged(unread)]),
      }),
    ).toEqual([]);

    const priced = run();
    const findings = detect({
      runs: [priced, unread],
      outcomes: byRun([closedUnmerged(priced), closedUnmerged(unread)]),
      frames: new Map([[priced.runId, framesOf(priced)]]),
    });
    const [finding] = findings;
    expect(finding).toMatchObject({
      savingMicros: 3n * TURN_MICROS,
      confidence: "medium",
      citedRuns: [priced.runId, unread.runId],
    });
    expect(finding!.evidence).toMatchObject({ calls: 4, coveredCalls: 3 });
    expect(finding!.claims).toHaveLength(3);
  });

  it("cites an unpriced frame and claims none for it", () => {
    const r = run();
    const frames = [...framesOf(r), frameAt(r, 10_000, null)];
    const [finding] = detect({
      runs: [r],
      outcomes: byRun([closedUnmerged(r)]),
      frames: new Map([[r.runId, frames]]),
    });
    expect(finding!.evidence).toMatchObject({ calls: 4, coveredCalls: 3 });
    expect(finding!.claims).toHaveLength(3);
  });

  it("groups by agent, and by operator when the run names no agent", () => {
    const agent = run();
    const anon = run({ agentKey: null });
    const findings = detect({
      runs: [agent, anon],
      outcomes: byRun([closedUnmerged(agent), closedUnmerged(anon)]),
      frames: new Map([
        [agent.runId, framesOf(agent)],
        [anon.runId, framesOf(anon)],
      ]),
    });
    expect(findings.map((f) => [f.level, f.subject]).sort()).toEqual([
      ["agent", AGENT],
      ["operator", OPERATOR],
    ]);
  });

  it("cites only runs that started after a person decided the finding", () => {
    const before = run();
    const after = run();
    const decided = new Date(
      (before.startedAt.getTime() + after.startedAt.getTime()) / 2,
    );
    const [finding] = detect({
      runs: [before, after],
      outcomes: byRun([closedUnmerged(before), closedUnmerged(after)]),
      frames: new Map([
        [before.runId, framesOf(before)],
        [after.runId, framesOf(after)],
      ]),
      decidedSince: new Map([
        [`spend_with_no_outcome|agent|${AGENT}`, decided],
      ]),
    });
    expect(finding!.citedRuns).toEqual([after.runId]);
  });
});

describe("the detector registry", () => {
  it("runs spend with no outcome after every detector that claims as 1 or 7", () => {
    const at = DETECTORS.indexOf(spendWithNoOutcome);
    expect(at).toBeGreaterThanOrEqual(0);
    DETECTORS.forEach((d, i) => {
      if (d.counting === 1 || d.counting === 7) expect(i).toBeLessThan(at);
    });
  });
});
