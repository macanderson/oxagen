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
  readTachoFileChanges: vi.fn(),
  readModelCallFrames: vi.fn(),
  chSelect: vi.fn(() => {
    throw new Error("the pass must not reach ClickHouse in this test");
  }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(),
}));
// The price book is read through the database, which this test never
// reaches; a pass that prices frames gets an empty book.
vi.mock("./price-book", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./price-book")>();
  return { ...actual, loadPriceBookSlice: vi.fn(async () => []) };
});
// The real detectors run; the spy lets a test read the input a pass built.
vi.mock("./findings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./findings")>();
  return { ...actual, detectFindings: vi.fn(actual.detectFindings) };
});

import { readModelCallFrames, type FrameRunRef } from "@oxagen/telemetry";
import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import {
  detectFindings,
  findingFingerprint,
  type DetectInput,
  type FindingClaim,
  type FindingDraft,
  type PricedRequestFrame,
  type RunCompaction,
  type RunFirstPrompt,
} from "./findings";
import {
  claimBackfill,
  CLAIMING_KINDS,
  FILE_CHANGE_READ_MAX,
  fileChangeTimesOf,
  frameReads,
  frameSources,
  planFrameReads,
  pricedFrames,
  readFrameRows,
  readPricedFrames,
  runFindingsPass,
  tachoRoots,
  TOOL_CALL_READ_MAX,
  toolWindowStart,
  toObservations,
  undecidedDrafts,
  type FrameRead,
} from "./findings-store";
import { loadPriceBookSlice, type PriceEntry } from "./price-book";
import type { OutcomeRow } from "./run-pr-outcomes";

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
    status: "ok",
    errorClass: null,
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

  it("carries each call's status and the error class of a failed call", () => {
    const [ok, failed] = toObservations(
      [
        row({ seq: 1 }),
        row({ seq: 2, status: "error", errorClass: "Exit code 1" }),
      ],
      new Map([[SESSION, RUN_ID]]),
    );
    expect([ok!.status, ok!.errorClass]).toEqual(["ok", null]);
    expect([failed!.status, failed!.errorClass]).toEqual([
      "error",
      "Exit code 1",
    ]);
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
    toolDefinitionTokens: null,
    contextFrameTokens: null,
    steeringTokens: null,
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

/** A run of the window with only the fields the frame plan reads. */
function planRun(
  runId: string,
  costMicros: bigint | null,
  runSource: "tacho" | "ledger" = "tacho",
): RunTotalsRecord {
  return { ...pricedRun(), runId, costMicros, runSource };
}

function tachoRef(root: string, ...children: string[]): FrameRunRef {
  return {
    kind: "tacho",
    rootSessionUuid: root,
    sessionUuids: [root, ...children],
  };
}

describe("planFrameReads", () => {
  const A = "tse_a";
  const B = "tse_b";
  const C = "tse_c";
  const D = "tse_d";
  const refs = new Map<string, FrameRunRef>([
    [A, tachoRef("00000000-0000-4000-8000-00000000000a")],
    [B, tachoRef("00000000-0000-4000-8000-00000000000b")],
    [C, tachoRef("00000000-0000-4000-8000-00000000000c")],
  ]);
  const runs = [
    planRun(A, 100n),
    planRun(B, 900n),
    planRun(C, null),
    planRun(D, 5_000n),
  ];

  it("reads every run with a source, most repeats first, then the dearest", () => {
    const { reads, coverage } = planFrameReads(
      runs,
      refs,
      new Map([[A, 2]]),
      10,
    );
    expect(reads.map((r) => r.runId)).toEqual([A, B, C]);
    expect(reads[0]?.ref).toBe(refs.get(A));
    expect(coverage).toEqual({ runs: 4, read: 3, capped: 0, unmatched: 1 });
  });

  it("counts the runs the cap leaves unread", () => {
    const { reads, coverage } = planFrameReads(runs, refs, new Map(), 1);
    expect(reads.map((r) => r.runId)).toEqual([B]);
    expect(coverage).toEqual({ runs: 4, read: 1, capped: 2, unmatched: 1 });
  });

  it("orders two runs of one cost by run id", () => {
    const { reads } = planFrameReads(
      [planRun(B, 10n), planRun(A, 10n)],
      refs,
      new Map(),
      10,
    );
    expect(reads.map((r) => r.runId)).toEqual([A, B]);
  });
});

describe("tachoRoots", () => {
  it("maps each wrapped run of the window to its root session", () => {
    const OTHER = "00000000-0000-4000-8000-0000000000bb";
    const out = tachoRoots(
      [planRun(RUN_ID, 1n), planRun("arun_x", 1n, "ledger")],
      new Map([
        [SESSION, RUN_ID],
        [OTHER, "tse_outside"],
      ]),
    );
    expect([...out]).toEqual([[RUN_ID, SESSION]]);
  });
});

describe("frameSources", () => {
  const SUBAGENT = "00000000-0000-4000-8000-0000000000cc";
  const LATER = "00000000-0000-4000-8000-0000000000dd";

  it("names a wrapped run's root and the chains its calls name when the store read none", () => {
    const out = frameSources(
      [planRun(RUN_ID, 1n)],
      [row({ sessionUuid: SUBAGENT })],
      new Map([[SESSION, RUN_ID]]),
      new Map(),
    );
    expect(out.get(RUN_ID)).toEqual(tachoRef(SESSION, SUBAGENT));
  });

  it("names a wrapped run with no tool call by its root alone", () => {
    const out = frameSources(
      [planRun(RUN_ID, 1n)],
      [],
      new Map([[SESSION, RUN_ID]]),
      new Map(),
    );
    expect(out.get(RUN_ID)).toEqual(tachoRef(SESSION));
  });

  it("joins the store's sessions to the calls' chains, and takes a ledger source as read", () => {
    const ledger: FrameRunRef = {
      kind: "ledger",
      runUuid: "00000000-0000-4000-8000-0000000000ee",
      originMessageId: null,
    };
    const out = frameSources(
      [planRun(RUN_ID, 1n), planRun("arun_x", 1n, "ledger")],
      [row({ sessionUuid: SUBAGENT })],
      new Map([[SESSION, RUN_ID]]),
      new Map<string, FrameRunRef>([
        [RUN_ID, tachoRef(SESSION, LATER)],
        ["arun_x", ledger],
        ["arun_outside", ledger],
      ]),
    );
    expect(out.get(RUN_ID)).toEqual(tachoRef(SESSION, SUBAGENT, LATER));
    expect(out.get("arun_x")).toBe(ledger);
    // A source for a run outside the window is dropped.
    expect(out.has("arun_outside")).toBe(false);
  });
});

describe("pricedFrames", () => {
  it("keys each frame by its instant and its place at that instant, and prices it once", () => {
    const out = pricedFrames(
      [],
      SCOPE.orgId,
      [
        frameRow(),
        frameRow({ reportedCostMicros: null }),
        frameRow({ at: "2026-09-10T09:00:00.000000Z" }),
      ],
      SESSION,
    );
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
    const out = pricedFrames(
      [],
      SCOPE.orgId,
      [
        frameRow({ at: "2026-09-10T10:00:00.500900Z" }),
        frameRow({ at: "2026-09-10T10:00:00.500500Z" }),
      ],
      SESSION,
    );
    expect(out.map((f) => [f.key, f.atMicros])).toEqual([
      ["2026-09-10T10:00:00.500500Z#0", second + 500_500],
      ["2026-09-10T10:00:00.500900Z#0", second + 500_900],
    ]);
  });

  it("gives a frame the same key whatever order the store returns one instant's frames in", () => {
    const cheap = frameRow();
    const dear = frameRow({ reportedCostMicros: "30000" });
    const keyed = (rows: ModelCallFrameRow[]) =>
      pricedFrames([], SCOPE.orgId, rows, SESSION).map((f) => [
        f.key,
        f.costMicros,
      ]);
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

  it("names each frame's chain and keeps two chains' frames of one instant apart by it", () => {
    const SUBAGENT = "00000000-0000-4000-8000-0000000000cc";
    const root = frameRow({ sessionUuid: SESSION });
    const child = frameRow({ sessionUuid: SUBAGENT });
    const chained = (rows: ModelCallFrameRow[]) =>
      pricedFrames([], SCOPE.orgId, rows, SESSION).map((f) => [
        f.key,
        f.sessionUuid,
      ]);
    // The root's own chain reads as null, as a tool call's does; the
    // subagent's names its uuid.
    expect(chained([child, root])).toEqual([
      ["2026-09-10T10:00:00.500000Z#0", null],
      ["2026-09-10T10:00:00.500000Z#1", SUBAGENT],
    ]);
    expect(chained([root, child])).toEqual(chained([child, root]));
    // A row that names no chain gives a frame with none.
    expect(
      pricedFrames([], SCOPE.orgId, [frameRow()], SESSION)[0],
    ).not.toHaveProperty("sessionUuid");
  });

  it("carries the frame's model, tokens per class, and the price entry of each class at its instant", () => {
    const entry = (over: Partial<PriceEntry>): PriceEntry => ({
      id: "pe_input",
      orgId: null,
      provider: "anthropic",
      model: "claude-sonnet-5",
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: 3_000_000n,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      source: "list",
      ...over,
    });
    const book = [
      entry({}),
      // Retired before the frame's instant, so the frame does not take it.
      entry({
        id: "pe_output_old",
        tokenClass: "output",
        effectiveTo: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ];
    const [frame] = pricedFrames(
      book,
      SCOPE.orgId,
      [
        frameRow({
          toolDefinitionTokens: 40,
          contextFrameTokens: 7,
          steeringTokens: 3,
        }),
      ],
      SESSION,
    );
    expect(frame).toMatchObject({
      model: "claude-sonnet-5",
      provider: "anthropic",
      classTokens: {
        input_uncached: 100,
        cache_read: 20,
        cache_write_5m: 5,
        cache_write_1h: 0,
        output: 50,
        reasoning: 10,
        server_tool_request: 3,
      },
      toolDefinitionTokens: 40,
      contextFrameTokens: 7,
      steeringTokens: 3,
      systemContextDigest: null,
      systemContextParts: null,
    });
    expect(frame?.classPrices?.input_uncached).toEqual({
      entryId: "pe_input",
      microsPerMillion: 3_000_000n,
      currency: "USD",
      source: "list",
    });
    expect(frame?.classPrices?.output).toBeNull();
    expect(frame?.classPrices?.cache_read).toBeNull();
  });

  it("gives each frame the parts the run last listed for its digest", () => {
    const part = {
      kind: "tool" as const,
      name: "Bash",
      provider: "builtin",
      digest: "sha256:tool",
      tokens: 120,
    };
    const out = pricedFrames(
      [],
      SCOPE.orgId,
      [
        // A digest no earlier frame listed has no parts.
        frameRow({
          at: "2026-09-10T09:00:00.000000Z",
          systemContextDigest: "sha256:ctx",
        }),
        frameRow({
          at: "2026-09-10T09:01:00.000000Z",
          systemContextDigest: "sha256:ctx",
          systemContextParts: [part],
        }),
        frameRow({
          at: "2026-09-10T09:02:00.000000Z",
          systemContextDigest: "sha256:ctx",
        }),
        frameRow({
          at: "2026-09-10T09:03:00.000000Z",
          systemContextDigest: "sha256:other",
        }),
      ],
      SESSION,
    );
    expect(out.map((f) => [f.systemContextDigest, f.systemContextParts])).toEqual(
      [
        ["sha256:ctx", null],
        ["sha256:ctx", [part]],
        ["sha256:ctx", [part]],
        ["sha256:other", null],
      ],
    );
  });

  // #4506 pass 6. A frame of the same instant can become visible after a
  // pass keyed the others, for example when a new chain widens the frame
  // reads. A key built from the frame's place at that instant then moves,
  // and an applied finding's claim no longer matches the frame a later
  // detector claims. A key built from the chain and seq does not move.
  it("keeps every frame's key when a later read adds a frame of the same instant that sorts first", () => {
    const SUBAGENT = "00000000-0000-4000-8000-0000000000cc";
    // A chain whose uuid sorts ahead of every chain the first read held.
    const EARLY = "00000000-0000-4000-8000-000000000003";
    const keyByCost = (rows: ModelCallFrameRow[]) =>
      new Map(
        pricedFrames([], SCOPE.orgId, rows, SESSION).map((f) => [
          f.costMicros,
          f.key,
        ]),
      );
    const read = [
      frameRow({ sessionUuid: SESSION, seq: 9 }),
      frameRow({ sessionUuid: SUBAGENT, seq: 4, reportedCostMicros: "30000" }),
    ];
    const before = keyByCost(read);
    expect([...before]).toEqual([
      [15_000n, `2026-09-10T10:00:00.500000Z#${SESSION}:9`],
      [30_000n, `2026-09-10T10:00:00.500000Z#${SUBAGENT}:4`],
    ]);
    // Each new frame sorts ahead of the first read's frames by its content,
    // and by its chain or its seq.
    const after = keyByCost([
      frameRow({ sessionUuid: SESSION, seq: 2, reportedCostMicros: "1000" }),
      frameRow({ sessionUuid: EARLY, seq: 1, reportedCostMicros: "2000" }),
      ...read,
    ]);
    expect(after.size).toBe(4);
    for (const [cost, key] of before) expect(after.get(cost)).toBe(key);
    expect(new Set(after.values()).size).toBe(4);
  });

  // #4506 pass 7: a call that names no model has no price, even when the
  // harness reported a figure for it.
  it("keeps a row that names no model as a frame with no price", () => {
    const [frame] = pricedFrames(
      [],
      SCOPE.orgId,
      [frameRow({ model: "", sessionUuid: SESSION, seq: 3 })],
      SESSION,
    );
    expect(frame).toMatchObject({
      key: `2026-09-10T10:00:00.500000Z#${SESSION}:3`,
      costMicros: null,
      basis: null,
      sessionUuid: null,
      seq: 3,
      noModel: true,
    });
    // A row that names its model is priced as before, and is not marked.
    const [named] = pricedFrames(
      [],
      SCOPE.orgId,
      [frameRow({ sessionUuid: SESSION, seq: 4 })],
      SESSION,
    );
    expect(named).toMatchObject({ costMicros: 15_000n, basis: "estimated" });
    expect(named).not.toHaveProperty("noModel");
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
    // The window has no run, so no model-call frame was read.
    expect(readFrames).not.toHaveBeenCalled();
  });

  it("passes each run's source, first prompt, file changes, compactions, outcomes, and frame coverage to the detectors", async () => {
    const LEDGER_RUN = "arun_0000000000000000000001";
    const ledger = planRun(LEDGER_RUN, 3_000n, "ledger");
    const ledgerRef: FrameRunRef = {
      kind: "ledger",
      runUuid: "00000000-0000-4000-8000-0000000000ee",
      originMessageId: null,
    };
    const prompt: RunFirstPrompt = {
      at: new Date("2026-09-10T09:59:00.000Z"),
      atMicros: Date.parse("2026-09-10T09:59:00.000Z") * 1_000,
      digest: "sha256:prompt",
      source: "typed",
      origin: null,
      commandName: null,
    };
    const compaction: RunCompaction = {
      at: new Date("2026-09-10T10:30:00.000Z"),
      atMicros: Date.parse("2026-09-10T10:30:00.000Z") * 1_000,
      seq: 9,
      sessionUuid: null,
      trigger: "auto",
      tokensBefore: 180_000,
      tokensAfter: 20_000,
    };
    const outcomes = new Map<string, OutcomeRow[]>();
    const readRunRefs = vi.fn(
      async () => new Map<string, FrameRunRef>([[LEDGER_RUN, ledgerRef]]),
    );
    const readFirstPrompts = vi.fn(async () => new Map([[RUN_ID, prompt]]));
    const readFileChanges = vi.fn(async () => new Map([[RUN_ID, true]]));
    const readCompactions = vi.fn(
      async () => new Map([[RUN_ID, [compaction]]]),
    );
    const readOutcomes = vi.fn(async () => outcomes);
    const readFrames = vi.fn(
      async () =>
        new Map<string, PricedRequestFrame[]>([
          [LEDGER_RUN, []],
          [RUN_ID, []],
        ]),
    );
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [pricedRun(), ledger],
      readRootSessions: async () => new Map([[SESSION, RUN_ID]]),
      readToolCalls: async () => [],
      readFrames,
      readDecisions: async () => new Map(),
      readRunRefs,
      readFirstPrompts,
      readFileChanges,
      readCompactions,
      readOutcomes,
      write: async () => 0,
    });
    const seen: DetectInput | undefined =
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0];
    const roots = new Map([[RUN_ID, SESSION]]);
    expect(readRunRefs).toHaveBeenCalledWith(
      SCOPE,
      [pricedRun(), ledger],
      new Map([[SESSION, RUN_ID]]),
    );
    expect(readFirstPrompts).toHaveBeenCalledWith(SCOPE, roots, WINDOW_START);
    expect(readFileChanges).toHaveBeenCalledWith(SCOPE, roots);
    expect(readCompactions).toHaveBeenCalledWith(SCOPE, roots, WINDOW_START);
    expect(readOutcomes).toHaveBeenCalledWith(SCOPE, [RUN_ID, LEDGER_RUN]);
    // Neither run repeated a call and both cost the same, so run id orders them.
    expect(readFrames).toHaveBeenCalledWith(SCOPE, [
      { runId: LEDGER_RUN, ref: ledgerRef },
      { runId: RUN_ID, ref: tachoRef(SESSION) },
    ]);
    expect(seen?.firstPrompts?.get(RUN_ID)).toBe(prompt);
    expect(seen?.fileChanges?.get(RUN_ID)).toBe(true);
    expect(seen?.compactions?.get(RUN_ID)).toEqual([compaction]);
    expect(seen?.outcomes).toBe(outcomes);
    expect(seen?.frameCoverage).toEqual({
      runs: 2,
      read: 2,
      capped: 0,
      unmatched: 0,
    });
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

describe("fileChangeTimesOf", () => {
  const OTHER = "00000000-0000-4000-8000-0000000000bb";
  const change = (at: string, rootSessionUuid = SESSION) => ({
    rootSessionUuid,
    sessionUuid: rootSessionUuid,
    at,
    seq: 1,
  });

  it("gives each run of the window its change times in microseconds, ascending, read from the window's start", () => {
    const out = fileChangeTimesOf(
      [
        change("2026-09-10T10:00:02.000500Z"),
        change("2026-09-10T10:00:01.000000Z"),
        change("2026-09-10T10:00:01.000000Z", OTHER),
      ],
      new Map([[SESSION, RUN_ID]]),
      WINDOW_START,
      10,
    );
    expect(out.from).toEqual(WINDOW_START);
    expect(out.byRun).toEqual(
      new Map([
        [
          RUN_ID,
          [
            Date.parse("2026-09-10T10:00:01Z") * 1_000,
            Date.parse("2026-09-10T10:00:02Z") * 1_000 + 500,
          ],
        ],
      ]),
    );
  });

  it("starts the read at the oldest change read when the read hit its cap", () => {
    const out = fileChangeTimesOf(
      [change("2026-09-12T00:00:00.000Z"), change("2026-09-11T00:00:00.000Z")],
      new Map([[SESSION, RUN_ID]]),
      WINDOW_START,
      2,
    );
    expect(out.from).toEqual(new Date("2026-09-11T00:00:00.000Z"));
  });
});

/**
 * The deps a pass over RUN_ID needs, with its tool calls and frames; null
 * frames leave the run's frames unread.
 */
function passDeps(
  calls: ToolCallObservationRow[],
  frames: PricedRequestFrame[] | null,
  write: (
    s: unknown,
    at: Date,
    decided: ReadonlyMap<string, Date>,
    drafts: readonly FindingDraft[],
  ) => Promise<number>,
) {
  return {
    now: () => NOW,
    readRuns: async () => [pricedRun()],
    readRootSessions: async () => new Map([[SESSION, RUN_ID]]),
    readToolCalls: async () => calls,
    readFrames: vi.fn(
      async () =>
        new Map<string, PricedRequestFrame[]>(
          frames === null ? [] : [[RUN_ID, frames]],
        ),
    ),
    readDecisions: async () => new Map<string, Date>(),
    write,
  };
}

describe("a call the hook recorded no input for (#4506)", () => {
  const original = row({ seq: 1, at: "2026-09-10T10:00:01.000Z" });
  const repeat = row({ seq: 2, at: "2026-09-10T10:00:02.000Z" });
  const noInput = row({
    seq: 3,
    at: "2026-09-10T10:00:02.100Z",
    inputDigest: "",
    outputDigest: "other",
  });
  const frames = [
    pricedFrame("2026-09-10T10:00:00.500Z", 15_000n),
    pricedFrame("2026-09-10T10:00:01.500Z", 15_000n),
  ];

  it("keeps a request with a repeat and a call with no input digest out of every repeat finding, from the store's rows", async () => {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    // Without the call, the second request only repeated, and it counts.
    await runFindingsPass(SCOPE, passDeps([original, repeat], frames, write));
    expect(write.mock.calls[0]?.[3].map((d) => d.kind)).toEqual([
      "repeated_shell_commands",
    ]);

    await runFindingsPass(
      SCOPE,
      passDeps([original, repeat, noInput], frames, write),
    );
    const drafts = write.mock.calls[1]?.[3] ?? [];
    expect(
      drafts.filter(
        (d) =>
          d.kind === "duplicate_tool_calls" ||
          d.kind === "repeated_shell_commands",
      ),
    ).toEqual([]);
    expect(drafts.flatMap((d) => d.claims ?? [])).toEqual([]);
  });

  it("prices a large result from such a call as an unpaged result, since it is not a repeat", async () => {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const large = row({ inputDigest: "", resultTokens: 25_000 });
    // The run's frames were not read, so the result is priced once at the
    // run's input price, 3 micros a token, against a 4,000-token page.
    await runFindingsPass(SCOPE, passDeps([large], null, write));
    expect(write.mock.calls[0]?.[3]).toEqual([
      expect.objectContaining({
        kind: "unpaged_results",
        subject: "Bash",
        citedRuns: [RUN_ID],
        savingMicros: 63_000n,
      }),
    ]);
  });
});

describe("retry loops in a pass", () => {
  const failing = (seq: number, at: string) =>
    row({
      seq,
      at,
      outputDigest: "",
      resultTokens: null,
      status: "error",
      errorClass: "Exit code 1",
    });
  const calls = [
    failing(1, "2026-09-10T10:00:01.000Z"),
    failing(2, "2026-09-10T10:00:02.000Z"),
    failing(3, "2026-09-10T10:00:03.000Z"),
  ];
  const frames = [
    pricedFrame("2026-09-10T10:00:00.500Z", 15_000n),
    pricedFrame("2026-09-10T10:00:01.500Z", 15_000n),
    pricedFrame("2026-09-10T10:00:02.500Z", 15_000n),
  ];

  it("reads the window's file changes, reads the run's frames for its retries, and prices the requests that only retried", async () => {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readFileChangeRows = vi.fn(async () => []);
    const deps = { ...passDeps(calls, frames, write), readFileChangeRows };
    await runFindingsPass(SCOPE, deps);
    expect(readFileChangeRows).toHaveBeenCalledWith({
      ...SCOPE,
      from: WINDOW_START,
      to: NOW,
      limit: FILE_CHANGE_READ_MAX,
    });
    expect(deps.readFrames).toHaveBeenCalledWith(SCOPE, [
      { runId: RUN_ID, ref: tachoRef(SESSION) },
    ]);
    const drafts = write.mock.calls[0]?.[3] ?? [];
    expect(drafts).toEqual([
      expect.objectContaining({
        kind: "retry_loops",
        level: "agent",
        subject: "acme.core.cc",
        savingMicros: 30_000n,
      }),
    ]);
    expect(drafts[0]?.claims?.map((c) => [c.detector, c.frameKey])).toEqual([
      [1, frames[1]!.key],
      [1, frames[2]!.key],
    ]);
  });

  it("finds no loop across a file change between two of the calls", async () => {
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readFileChangeRows = vi.fn(async () => [
      {
        rootSessionUuid: SESSION,
        sessionUuid: SESSION,
        at: "2026-09-10T10:00:02.500000Z",
        seq: 9,
      },
    ]);
    await runFindingsPass(SCOPE, {
      ...passDeps(calls, frames, write),
      readFileChangeRows,
    });
    expect(write.mock.calls[0]?.[3]).toEqual([]);
  });
});

describe("readFrameRows", () => {
  const runs: FrameRead[] = ["a", "b", "c", "d", "e"].map((runId) => ({
    runId,
    ref: tachoRef(SESSION),
  }));
  const sizes: Record<string, number> = { a: 3, b: 4, c: 5, d: 1, e: 1 };
  const read = (r: FrameRead) =>
    Promise.resolve(Array.from({ length: sizes[r.runId]! }, (_, i) => i));

  it("holds at most the cap, and drops the first run that would pass it with every run after it", async () => {
    const reader = vi.fn(read);
    const { rows, peak } = await readFrameRows(runs, reader, 10, 2);
    expect([...rows.keys()]).toEqual(["a", "b"]);
    expect(peak).toBe(7);
    expect(peak).toBeLessThanOrEqual(10);
    // The batch that passed the cap was read, and no batch after it.
    expect(reader.mock.calls.map(([r]) => r.runId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("reads every run while their frames fit", async () => {
    const { rows, peak } = await readFrameRows(runs, read, 14, 2);
    expect([...rows.keys()]).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(14);
  });
});

describe("a pass with more frames than it may hold", () => {
  const OTHER = "00000000-0000-4000-8000-0000000000bb";
  const OTHER_RUN = "tse_0000000000000000000002";

  it("prices the runs that fit, counts the rest as capped, and still writes its findings", async () => {
    vi.mocked(loadPriceBookSlice).mockClear();
    vi.mocked(readModelCallFrames).mockImplementation(async ({ run }) =>
      run.kind === "tacho" && run.rootSessionUuid === SESSION
        ? [
            frameRow({ at: "2026-09-10T10:00:00.500000Z" }),
            frameRow({ at: "2026-09-10T10:00:01.500000Z" }),
          ]
        : Array.from({ length: 5 }, (_, i) =>
            frameRow({
              at: `2026-09-10T11:00:0${i}.000000Z`,
              model: "claude-opus-5",
            }),
          ),
    );
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const read = (at: string, rootSessionUuid: string) =>
      row({
        at,
        rootSessionUuid,
        sessionUuid: rootSessionUuid,
        tool: "Read",
        isMutating: false,
      });
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [
        pricedRun(),
        { ...planRun(OTHER_RUN, 3_000n), agentKey: "acme.core.other" },
      ],
      readRootSessions: async () =>
        new Map([
          [SESSION, RUN_ID],
          [OTHER, OTHER_RUN],
        ]),
      readToolCalls: async () => [
        row({ seq: 1, at: "2026-09-10T10:00:01.000Z" }),
        row({ seq: 2, at: "2026-09-10T10:00:02.000Z" }),
        read("2026-09-10T11:00:01.500Z", OTHER),
        read("2026-09-10T11:00:02.500Z", OTHER),
      ],
      // The first run's 2 frames fit a cap of 3, and the second's 5 do not.
      readFrames: (scope, reads) => readPricedFrames(scope, reads, 3),
      readDecisions: async () => new Map(),
      write,
    });
    expect(readModelCallFrames).toHaveBeenCalledTimes(2);
    // Only the frames the pass kept are priced.
    expect(loadPriceBookSlice).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      models: ["claude-sonnet-5"],
      from: new Date("2026-09-10T10:00:00.500Z"),
      to: new Date("2026-09-10T10:00:01.500Z"),
    });
    const seen: DetectInput | undefined =
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0];
    expect([...(seen?.frames?.keys() ?? [])]).toEqual([RUN_ID]);
    expect(seen?.frameCoverage).toEqual({
      runs: 2,
      read: 1,
      capped: 1,
      unmatched: 0,
    });
    // The run that fit has its repeat priced at its request's reported cost.
    expect(write.mock.calls[0]?.[3]).toEqual([
      expect.objectContaining({
        kind: "repeated_shell_commands",
        citedRuns: [RUN_ID],
        savingMicros: 15_000n,
      }),
    ]);
  });
});

describe("calls that named no model (#4506)", () => {
  it("reads them only for the pass, and leaves them out of the price book slice", async () => {
    vi.mocked(loadPriceBookSlice).mockClear();
    vi.mocked(readModelCallFrames).mockReset();
    vi.mocked(readModelCallFrames).mockImplementation(async () => [
      frameRow({ model: "", sessionUuid: SESSION, seq: 1 }),
      frameRow({ sessionUuid: SESSION, seq: 2 }),
    ]);
    const runs: FrameRead[] = [{ runId: RUN_ID, ref: tachoRef(SESSION) }];
    const kept = await readPricedFrames(SCOPE, runs, 10, true);
    expect(readModelCallFrames).toHaveBeenLastCalledWith({
      ...SCOPE,
      run: tachoRef(SESSION),
      keepModelless: true,
    });
    expect(kept.get(RUN_ID)?.map((f) => f.noModel === true)).toEqual([
      true,
      false,
    ]);
    expect(loadPriceBookSlice).toHaveBeenLastCalledWith(
      expect.objectContaining({ models: ["claude-sonnet-5"] }),
    );
    // Every other reader asks for priced frames alone.
    await readPricedFrames(SCOPE, runs, 10);
    expect(readModelCallFrames).toHaveBeenLastCalledWith({
      ...SCOPE,
      run: tachoRef(SESSION),
    });
  });

  it("hands them to the request view alone, and the repeat after one claims no priced frame", async () => {
    const priced = pricedFrame("2026-09-10T10:00:00.500Z", 15_000n);
    const answered = pricedFrame("2026-09-10T10:00:01.500Z", 15_000n);
    const modelless: PricedRequestFrame = {
      ...pricedFrame("2026-09-10T10:00:02.500Z", 15_000n),
      costMicros: null,
      basis: null,
      model: "",
      noModel: true,
    };
    const calls = [
      row({ seq: 1, at: "2026-09-10T10:00:01.000Z" }),
      row({ seq: 2, at: "2026-09-10T10:00:03.000Z" }),
    ];
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    // Without the call that named no model, the repeat lands on the request
    // that only answered in text, and the finding claims its price.
    await runFindingsPass(
      SCOPE,
      passDeps(calls, [priced, answered], write),
    );
    expect(
      write.mock.calls[0]?.[3].flatMap((d) => d.claims ?? []).map((c) => c.frameKey),
    ).toEqual([answered.key]);

    await runFindingsPass(
      SCOPE,
      passDeps(calls, [priced, answered, modelless], write),
    );
    const seen: DetectInput | undefined =
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0];
    expect(seen?.frames?.get(RUN_ID)).toEqual([priced, answered]);
    expect(seen?.modellessFrames?.get(RUN_ID)).toEqual([modelless]);
    expect(seen?.frameCoverage).toMatchObject({ read: 1, capped: 0 });
    expect(write.mock.calls[1]?.[3]).toEqual([]);
  });
});

describe("claims for applied findings with none (#4506)", () => {
  const A = "tse_a";
  const B = "tse_b";
  const claim = (runId: string, frameKey: string): FindingClaim => ({
    detector: 1,
    runId,
    frameKey,
    frameAt: new Date("2026-09-10T10:00:01.500Z"),
    operatorKey: null,
    costMicros: 15_000n,
  });

  it("names the kinds whose findings claim frames", () => {
    expect([...CLAIMING_KINDS]).toEqual([
      "spin_loops",
      "retry_loops",
      "repeated_shell_commands",
      "duplicate_tool_calls",
      "recurring_runs",
      "spend_with_no_outcome",
    ]);
  });

  it("gives an applied finding the replayed claims in the runs it cited, and skips one the replay gives none", () => {
    const out = claimBackfill(
      [
        {
          id: "f1",
          fingerprint: "spin_loops|agent|x",
          citedRuns: [A],
          currency: "USD",
        },
        {
          id: "f2",
          fingerprint: "spin_loops|agent|y",
          citedRuns: [A],
          currency: "USD",
        },
      ],
      new Map([
        ["spin_loops|agent|x", [claim(A, "k1"), claim(B, "k2")]],
        ["spin_loops|agent|y", [claim(B, "k3")]],
      ]),
    );
    expect(out).toEqual([
      { findingId: "f1", currency: "USD", claims: [claim(A, "k1")] },
    ]);
  });

  it("replays the pass for an applied finding with no claim rows, and stores the frames it priced in the runs it cited", async () => {
    const fingerprint = findingFingerprint(
      "repeated_shell_commands",
      "tool",
      "Bash",
    );
    const frames = [
      pricedFrame("2026-09-10T10:00:00.500Z", 15_000n),
      pricedFrame("2026-09-10T10:00:01.500Z", 15_000n),
    ];
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readUnclaimedApplied = vi.fn(async () => [
      { id: "fnd-applied", fingerprint, citedRuns: [RUN_ID], currency: "USD" },
    ]);
    const writeClaimBackfill = vi.fn(async () => undefined);
    await runFindingsPass(SCOPE, {
      ...passDeps(
        [
          row({ seq: 1, at: "2026-09-10T10:00:01.000Z" }),
          row({ seq: 2, at: "2026-09-10T10:00:02.000Z" }),
        ],
        frames,
        write,
      ),
      // Applied after the run started, so the pass cites the run no more.
      readDecisions: async () =>
        new Map([[fingerprint, new Date("2026-09-12T00:00:00.000Z")]]),
      readUnclaimedApplied,
      writeClaimBackfill,
    });
    expect(write.mock.calls[0]?.[3]).toEqual([]);
    expect(readUnclaimedApplied).toHaveBeenCalledWith(
      SCOPE,
      CLAIMING_KINDS,
      WINDOW_START,
    );
    expect(writeClaimBackfill).toHaveBeenCalledWith(SCOPE, [
      {
        findingId: "fnd-applied",
        currency: "USD",
        claims: [
          {
            detector: 1,
            runId: RUN_ID,
            frameKey: frames[1]!.key,
            frameAt: frames[1]!.at,
            operatorKey: null,
            costMicros: 15_000n,
          },
        ],
      },
    ]);
  });

  it("writes no backfill when every applied finding holds its claims", async () => {
    const writeClaimBackfill = vi.fn(async () => undefined);
    await runFindingsPass(SCOPE, {
      ...passDeps([], [], async () => 0),
      readUnclaimedApplied: async () => [],
      writeClaimBackfill,
    });
    expect(writeClaimBackfill).not.toHaveBeenCalled();
  });
});
