import { describe, expect, it, vi } from "vitest";
import type {
  ModelCallFrameRow,
  ToolCallObservationRow,
} from "@oxagen/telemetry";

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn(() => {
    throw new Error("the pass must not reach the database in this test");
  }),
}));
vi.mock("@oxagen/telemetry", () => ({
  readTachoToolCallObservations: vi.fn(),
  readModelCallFrames: vi.fn(),
}));

import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import type { FindingDraft, PricedRequestFrame } from "./findings";
import {
  frameReads,
  pricedFrames,
  runFindingsPass,
  TOOL_CALL_READ_MAX,
  toolWindowStart,
  toObservations,
  undecidedDrafts,
} from "./findings-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const NOW = new Date("2026-09-15T00:00:00.000Z");
const WINDOW_START = new Date("2026-08-16T00:00:00.000Z");
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const RUN_ID = "tse_0000000000000000000001";

function row(
  over: Partial<ToolCallObservationRow> = {},
): ToolCallObservationRow {
  return {
    rootSessionUuid: SESSION,
    sessionUuid: SESSION,
    at: "2026-09-10T10:00:00.000Z",
    seq: 1,
    tool: "Bash",
    inputDigest: "in",
    outputDigest: "out",
    isMutating: true,
    resultTokens: 5_000,
    ...over,
  };
}

function pricedRun(): RunTotalsRecord {
  return {
    runId: RUN_ID,
    runSource: "tacho",
    ...SCOPE,
    operatorPrincipalId: null,
    operatorKey: null,
    agentPrincipalId: null,
    agentKey: "acme.core.cc",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-10T09:59:00.000Z"),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 2,
    tokens: { ...ZERO_TOKENS, input_uncached: 1_000 },
    costMicros: 3_000n,
    currency: "USD",
    costBasis: "client_attested",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 1,
          tokens: { ...ZERO_TOKENS, input_uncached: 1_000 },
          costMicros: 3_000n,
          costByClass: {
            input_uncached: 3_000n,
            cache_read: 0n,
            cache_write_5m: 0n,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
            server_tool_request: 0n,
          },
          cacheSavingMicros: 0n,
          basis: "client_attested",
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
  };
}

describe("toolWindowStart", () => {
  it("is the window's start while the read stayed under its cap", () => {
    expect(toolWindowStart(WINDOW_START, [row()], 2)).toEqual(WINDOW_START);
  });

  it("is the oldest call read when the read hit its cap", () => {
    const rows = [
      row({ at: "2026-09-12T00:00:00.000Z" }),
      row({ at: "2026-09-11T00:00:00.000Z" }),
    ];
    expect(toolWindowStart(WINDOW_START, rows, 2)).toEqual(
      new Date("2026-09-11T00:00:00.000Z"),
    );
  });
});

describe("toObservations", () => {
  it("names each call by its root session's run and drops calls of sessions outside the window", () => {
    const out = toObservations(
      [row(), row({ rootSessionUuid: "00000000-0000-4000-8000-0000000000bb" })],
      new Map([[SESSION, RUN_ID]]),
    );
    expect(out).toEqual([
      expect.objectContaining({ runId: RUN_ID, tool: "Bash", seq: 1 }),
    ]);
  });

  it("keeps the store's microseconds, which a Date drops", () => {
    const [out] = toObservations(
      [row({ at: "2026-09-10T10:00:00.500500Z" })],
      new Map([[SESSION, RUN_ID]]),
    );
    expect(out!.at).toEqual(new Date("2026-09-10T10:00:00.500Z"));
    expect(out!.atMicros).toBe(
      Date.parse("2026-09-10T10:00:00Z") * 1_000 + 500_500,
    );
  });

  it("names a subagent's chain and leaves the root's own chain unnamed (#4001)", () => {
    const SUBAGENT = "00000000-0000-4000-8000-0000000000cc";
    const out = toObservations(
      [row({ seq: 4 }), row({ seq: 2, sessionUuid: SUBAGENT })],
      new Map([[SESSION, RUN_ID]]),
    );
    expect(out.map((o) => [o.seq, o.sessionUuid])).toEqual([
      [4, null],
      [2, SUBAGENT],
    ]);
  });
});

describe("undecidedDrafts", () => {
  const drafts = [
    { fingerprint: "a" },
    { fingerprint: "b" },
    { fingerprint: "c" },
  ] as FindingDraft[];
  const t = (iso: string) => new Date(`2026-09-14T${iso}:00.000Z`);

  it("keeps a draft with no decision, or with only the decision it was detected with", () => {
    expect(
      undecidedDrafts(
        drafts,
        new Map([["a", t("10:00")]]),
        new Map([["a", t("10:00")]]),
      ),
    ).toEqual(drafts);
  });

  it("leaves a fingerprint to a decision the pass did not read, whatever that decision's timestamp", () => {
    const out = undecidedDrafts(
      drafts,
      new Map([
        // Decided before the pass read decisions, committed after it.
        ["a", t("09:00")],
        // Decided again after the decision the pass read.
        ["b", t("11:00")],
      ]),
      new Map([["b", t("10:00")]]),
    );
    expect(out).toEqual([{ fingerprint: "c" }]);
  });
});

/** A priced frame of RUN_ID at `iso`, keyed as the store keys it. */
function pricedFrame(iso: string, costMicros: bigint): PricedRequestFrame {
  return {
    key: `${iso}#0`,
    at: new Date(iso),
    costMicros,
    tokens: 1_000,
    basis: "client_attested",
  };
}

function frameRow(over: Partial<ModelCallFrameRow> = {}): ModelCallFrameRow {
  return {
    at: "2026-09-10T10:00:00.500000Z",
    model: "claude-sonnet-5",
    provider: "anthropic",
    inputUncached: 100,
    cacheRead: 20,
    cacheWrite5m: 5,
    cacheWrite1h: 0,
    output: 50,
    reasoning: 10,
    serverToolRequests: 3,
    reportedCostMicros: "15000",
    basis: "client_attested",
    ...over,
  };
}

describe("frameReads", () => {
  const SUBAGENT = "00000000-0000-4000-8000-0000000000cc";
  const OTHER = "00000000-0000-4000-8000-0000000000bb";
  const OTHER_RUN = "tse_0000000000000000000002";

  it("reads the runs with the most repeats first, up to the cap, over the root and every chain the calls name", () => {
    const rows = [
      row(),
      row({ sessionUuid: SUBAGENT }),
      row({ rootSessionUuid: OTHER, sessionUuid: OTHER }),
    ];
    const bySession = new Map([
      [SESSION, RUN_ID],
      [OTHER, OTHER_RUN],
    ]);
    const repeats = new Map([
      [RUN_ID, 1],
      [OTHER_RUN, 3],
    ]);
    expect(frameReads(rows, bySession, repeats, 5)).toEqual([
      {
        runId: OTHER_RUN,
        ref: { kind: "tacho", rootSessionUuid: OTHER, sessionUuids: [OTHER] },
      },
      {
        runId: RUN_ID,
        ref: {
          kind: "tacho",
          rootSessionUuid: SESSION,
          sessionUuids: [SESSION, SUBAGENT],
        },
      },
    ]);
    expect(
      frameReads(rows, bySession, repeats, 1).map((r) => r.runId),
    ).toEqual([OTHER_RUN]);
  });

  it("skips a run it has no root session for", () => {
    expect(
      frameReads([row()], new Map([[SESSION, RUN_ID]]), new Map([["x", 9]]), 5),
    ).toEqual([]);
  });
});

describe("pricedFrames", () => {
  it("keys each frame by its instant and its place at that instant, and prices it once", () => {
    const out = pricedFrames([], SCOPE.orgId, [
      frameRow(),
      frameRow({ reportedCostMicros: null }),
      frameRow({ at: "2026-09-10T09:00:00.000000Z" }),
    ]);
    expect(out.map((f) => f.key)).toEqual([
      "2026-09-10T09:00:00.000000Z#0",
      "2026-09-10T10:00:00.500000Z#0",
      "2026-09-10T10:00:00.500000Z#1",
    ]);
    // No book entry prices the model, so the reported figure stands.
    expect(out[1]).toMatchObject({
      costMicros: 15_000n,
      basis: "estimated",
      tokens: 185,
    });
    // With no reported figure either, the frame is unpriced.
    expect(out[2]).toMatchObject({ costMicros: null, basis: null });
  });

  it("orders two frames of one millisecond by the microsecond", () => {
    const second = Date.parse("2026-09-10T10:00:00Z") * 1_000;
    const out = pricedFrames([], SCOPE.orgId, [
      frameRow({ at: "2026-09-10T10:00:00.500900Z" }),
      frameRow({ at: "2026-09-10T10:00:00.500500Z" }),
    ]);
    expect(out.map((f) => [f.key, f.atMicros])).toEqual([
      ["2026-09-10T10:00:00.500500Z#0", second + 500_500],
      ["2026-09-10T10:00:00.500900Z#0", second + 500_900],
    ]);
  });

  it("gives a frame the same key whatever order the store returns one instant's frames in", () => {
    const cheap = frameRow();
    const dear = frameRow({ reportedCostMicros: "30000" });
    const keyed = (rows: ModelCallFrameRow[]) =>
      pricedFrames([], SCOPE.orgId, rows).map((f) => [f.key, f.costMicros]);
    expect(keyed([dear, cheap])).toEqual([
      ["2026-09-10T10:00:00.500000Z#0", 15_000n],
      ["2026-09-10T10:00:00.500000Z#1", 30_000n],
    ]);
    expect(keyed([cheap, dear])).toEqual(keyed([dear, cheap]));
    // Two frames with the same content are interchangeable.
    expect(keyed([cheap, frameRow()])).toEqual([
      ["2026-09-10T10:00:00.500000Z#0", 15_000n],
      ["2026-09-10T10:00:00.500000Z#1", 15_000n],
    ]);
  });
});

describe("runFindingsPass", () => {
  it("reads a thirty-day window, prices the requests that only repeated, and writes at the pass's start", async () => {
    const readToolCalls = vi.fn(async () => [
      row({ seq: 1 }),
      row({ seq: 2, at: "2026-09-10T10:00:01.000Z" }),
    ]);
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readRuns = vi.fn(async () => [pricedRun()]);
    const readRootSessions = vi.fn(async () => new Map([[SESSION, RUN_ID]]));
    const frame = pricedFrame("2026-09-10T10:00:00.500Z", 15_000n);
    const readFrames = vi.fn(async () => new Map([[RUN_ID, [frame]]]));
    const decisions = new Map<string, Date>();
    const out = await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns,
      readRootSessions,
      readToolCalls,
      readFrames,
      readDecisions: async () => decisions,
      write,
    });

    expect(readRuns).toHaveBeenCalledWith(SCOPE, {
      start: WINDOW_START,
      end: NOW,
    });
    expect(readRootSessions).toHaveBeenCalledWith(SCOPE, WINDOW_START);
    expect(readToolCalls).toHaveBeenCalledWith({
      ...SCOPE,
      from: WINDOW_START,
      to: NOW,
      limit: TOOL_CALL_READ_MAX,
    });
    expect(readFrames).toHaveBeenCalledWith(SCOPE, [
      {
        runId: RUN_ID,
        ref: {
          kind: "tacho",
          rootSessionUuid: SESSION,
          sessionUuids: [SESSION],
        },
      },
    ]);
    expect(out).toEqual({ findings: 1 });
    const [scope, at, decided, drafts] = write.mock.calls[0]!;
    expect(scope).toEqual(SCOPE);
    expect(at).toEqual(NOW);
    expect(decided).toBe(decisions);
    // The request that made only the repeat counts at its whole price.
    expect(drafts).toEqual([
      expect.objectContaining({
        kind: "repeated_shell_commands",
        citedRuns: [RUN_ID],
        savingMicros: 15_000n,
        claims: [
          {
            detector: 1,
            runId: RUN_ID,
            frameKey: frame.key,
            frameAt: frame.at,
            operatorKey: null,
            costMicros: 15_000n,
          },
        ],
      }),
    ]);
    // The repeat on the root's chain is cited by its seq alone.
    expect(drafts[0]?.evidence.frames).toEqual({
      [RUN_ID]: { seqs: [{ seq: "2" }], total: 1 },
    });
  });

  it("writes no priced finding for a repeat whose run's frames were not read", async () => {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [pricedRun()],
      readRootSessions: async () => new Map([[SESSION, RUN_ID]]),
      readToolCalls: async () => [
        row({ seq: 1 }),
        row({ seq: 2, at: "2026-09-10T10:00:01.000Z" }),
      ],
      readFrames: async () => new Map(),
      readDecisions: async () => new Map(),
      write,
    });
    expect(write.mock.calls[0]?.[3]).toEqual([]);
  });

  it("writes no drafts for a workspace with no runs in the window, so its open findings are deleted", async () => {
    const write = vi.fn(async () => 0);
    const readFrames = vi.fn();
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [],
      readRootSessions: async () => new Map(),
      readToolCalls: async () => [],
      readFrames,
      readDecisions: async () => new Map(),
      write,
    });
    expect(write).toHaveBeenCalledWith(SCOPE, NOW, new Map(), []);
    // No run repeated a call, so no model-call frame was read.
    expect(readFrames).not.toHaveBeenCalled();
  });

  it("lets a degraded store fail the pass without writing", async () => {
    const write = vi.fn();
    await expect(
      runFindingsPass(SCOPE, {
        now: () => NOW,
        readRuns: async () => [],
        readRootSessions: async () => new Map(),
        readToolCalls: async () => {
          throw new Error("clickhouse down");
        },
        readFrames: async () => new Map(),
        readDecisions: async () => new Map(),
        write,
      }),
    ).rejects.toThrow("clickhouse down");
    expect(write).not.toHaveBeenCalled();
  });
});
