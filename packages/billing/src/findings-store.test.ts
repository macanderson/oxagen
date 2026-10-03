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
  readGroupModelCallFrames: vi.fn(),
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

import { createHash } from "node:crypto";
import {
  readGroupModelCallFrames,
  readModelCallFrames,
  type FrameRunRef,
} from "@oxagen/telemetry";
import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import {
  detectFindings,
  findingFingerprint,
  instructionLineage,
  type DetectInput,
  type FindingClaim,
  type FindingDraft,
  type PricedRequestFrame,
  type PromptRead,
  type RunCompaction,
  type RunFirstPrompt,
  type RunPrompt,
} from "./findings";
import type { SpendProposalInput } from "./findings/proposal-opener";
import { RECURRING_RUNS_MIN } from "./findings/recurring-runs";
import {
  claimBackfill,
  CLAIMING_KINDS,
  FILE_CHANGE_READ_MAX,
  fileChangeTimesOf,
  FRAME_GROUP_READ_SESSIONS,
  FRAME_GROUP_READS_RESERVE,
  FRAME_READ_MAX_FRAMES,
  FRAME_READS_MAX,
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

describe("planFrameReads with recurring groups (#5168)", () => {
  /** `n` runs named `tse_<name><i>`, each at `cost`. */
  const many = (name: string, n: number, cost: bigint) =>
    Array.from({ length: n }, (_, i) =>
      planRun(`tse_${name}${String(i).padStart(3, "0")}`, cost),
    );
  const firstPrompt = (
    digest: string,
    source: string | null = null,
  ): RunFirstPrompt => ({
    at: new Date("2026-09-10T09:59:00.000Z"),
    atMicros: Date.parse("2026-09-10T09:59:00.000Z") * 1_000,
    digest,
    source,
    origin: null,
    commandName: null,
  });
  /** Each group's runs started with the group's prompt digest. */
  const promptsOf = (
    groups: readonly (readonly [string, readonly RunTotalsRecord[]])[],
  ) =>
    new Map(
      groups.flatMap(([digest, runs]) =>
        runs.map((r) => [r.runId, firstPrompt(digest)] as const),
      ),
    );
  /** A root session for every run, numbered from 1. */
  const rootOf = (i: number) =>
    `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
  /** A frame source for every run: its own root, and `children` more sessions. */
  const everyRef = (runs: readonly RunTotalsRecord[], children = 0) =>
    new Map(
      runs.map((r, i) => [
        r.runId,
        tachoRef(
          rootOf(i),
          ...Array.from({ length: children }, (_, c) =>
            rootOf(100_000 + i * 10 + c),
          ),
        ),
      ]),
    );
  const ids = (runs: readonly { runId: string }[]) => runs.map((r) => r.runId);
  /** Each read's group number, or null on a run read alone. */
  const groupsOf = (reads: readonly FrameRead[]) =>
    reads.map((r) => r.group ?? null);

  it("reads a cheap recurring job in one group read ahead of 200 dearer runs that each repeat a call", () => {
    // $1.00 a run, and each run repeats a call.
    const dear = many("dear", 300, 1_000_000n);
    // A scheduled job: 10 runs of one prompt, at $0.32 a run.
    const job = many("job", 10, 320_000n);
    const runs = [...dear, ...job];
    const repeats = new Map(dear.map((r) => [r.runId, 1]));

    // The ranking alone gives every place to the dearer runs.
    const before = planFrameReads(
      runs,
      everyRef(runs),
      repeats,
      FRAME_READS_MAX,
    );
    expect(ids(before.reads).filter((id) => id.startsWith("tse_job"))).toEqual(
      [],
    );

    const { reads, coverage } = planFrameReads(
      runs,
      everyRef(runs),
      repeats,
      FRAME_READS_MAX,
      promptsOf([["sha256:job", job]]),
    );
    // The job's runs are read first, in one read, so the frame cap cannot
    // drop them.
    expect(ids(reads.slice(0, job.length))).toEqual(ids(job));
    expect(groupsOf(reads.slice(0, job.length))).toEqual(
      Array<number>(job.length).fill(0),
    );
    // The group took one place, and the ranking keeps the other 199.
    expect(ids(reads.slice(job.length))).toEqual(
      ids(dear.slice(0, FRAME_READS_MAX - 1)),
    );
    expect(groupsOf(reads.slice(job.length))).toEqual(
      Array<null>(FRAME_READS_MAX - 1).fill(null),
    );
    expect(coverage).toEqual({
      runs: 310,
      read: job.length + FRAME_READS_MAX - 1,
      capped: 300 - (FRAME_READS_MAX - 1),
      unmatched: 0,
    });
  });

  it("reads a 400-run job whole in one group read, where the run reserve read 50 of its runs", () => {
    const dear = many("dear", 300, 1_000_000n);
    const job = many("job", 400, 320_000n);
    const runs = [...dear, ...job];
    const { reads, coverage } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([["sha256:job", job]]),
    );
    expect(ids(reads.slice(0, job.length))).toEqual(ids(job));
    expect(new Set(groupsOf(reads.slice(0, job.length)))).toEqual(
      new Set([0]),
    );
    expect(ids(reads.slice(job.length))).toEqual(
      ids(dear.slice(0, FRAME_READS_MAX - 1)),
    );
    expect(coverage).toEqual({
      runs: 700,
      read: 400 + FRAME_READS_MAX - 1,
      capped: 300 - (FRAME_READS_MAX - 1),
      unmatched: 0,
    });
  });

  it("leaves a prompt that started too few runs to recur to the ranking", () => {
    const dear = many("dear", 300, 1_000_000n);
    const few = many("few", RECURRING_RUNS_MIN - 1, 320_000n);
    const runs = [...dear, ...few];
    const { reads } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([["sha256:few", few]]),
    );
    expect(ids(reads)).toEqual(ids(dear.slice(0, FRAME_READS_MAX)));
    expect(reads.every((r) => r.group === undefined)).toBe(true);
  });

  it("gives each recurring group one read, dearest group first, and takes its runs out of the ranking", () => {
    // $80, $6, and $0.40 in all.
    const dearJob = many("a", 40, 2_000_000n);
    const largeJob = many("b", 60, 100_000n);
    const smallJob = many("c", 8, 50_000n);
    const dear = many("dear", 300, 1_000_000n);
    const runs = [...dearJob, ...largeJob, ...smallJob, ...dear];
    const { reads } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([
        ["sha256:a", dearJob],
        ["sha256:b", largeJob],
        ["sha256:c", smallJob],
      ]),
    );
    // The dear job is read in its group read, so the ranking does not read
    // it again, and each of the three groups takes one place.
    expect(ids(reads)).toEqual([
      ...ids(dearJob),
      ...ids(largeJob),
      ...ids(smallJob),
      ...ids(dear.slice(0, FRAME_READS_MAX - 3)),
    ]);
    expect(groupsOf(reads)).toEqual([
      ...Array<number>(dearJob.length).fill(0),
      ...Array<number>(largeJob.length).fill(1),
      ...Array<number>(smallJob.length).fill(2),
      ...Array<null>(FRAME_READS_MAX - 3).fill(null),
    ]);
    expect(new Set(ids(reads)).size).toBe(reads.length);
  });

  it(`keeps ${FRAME_GROUP_READS_RESERVE} reads for groups and leaves the cheaper groups' runs to the ranking`, () => {
    const extra = 5;
    // Job i's runs cost less as i grows, so the order of the groups is known.
    const jobs = Array.from({ length: FRAME_GROUP_READS_RESERVE + extra }, (_, i) =>
      many(`job${String(i).padStart(2, "0")}_`, RECURRING_RUNS_MIN, BigInt(1_000 - i) * 1_000n),
    );
    const runs = jobs.flat();
    const { reads, coverage } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf(jobs.map((job, i) => [`sha256:job${i}`, job] as const)),
    );
    const grouped = reads.filter((r) => r.group !== undefined);
    expect(new Set(groupsOf(grouped)).size).toBe(FRAME_GROUP_READS_RESERVE);
    expect(ids(grouped)).toEqual(
      ids(jobs.slice(0, FRAME_GROUP_READS_RESERVE).flat()),
    );
    // The other groups' runs are read one by one, in the places left.
    expect(ids(reads.filter((r) => r.group === undefined))).toEqual(
      ids(jobs.slice(FRAME_GROUP_READS_RESERVE).flat()),
    );
    expect(coverage).toMatchObject({ read: runs.length, capped: 0 });
  });

  it("splits a group whose sessions pass the bound into reads that each fit, one place each", () => {
    const job = many("job", 10, 320_000n);
    const dear = many("dear", 10, 1_000_000n);
    const runs = [...job, ...dear];
    // Each run names its root and one subagent chain: 2 sessions.
    const refs = everyRef(runs, 1);
    const prompts = promptsOf([["sha256:job", job]]);

    const { reads } = planFrameReads(runs, refs, new Map(), 7, prompts, {
      groupSessions: 5,
    });
    // 2 runs, 4 sessions, fit one read; a third would name 6.
    expect(ids(reads.slice(0, job.length))).toEqual(ids(job));
    expect(groupsOf(reads.slice(0, job.length))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
    // 5 group reads leave 2 of 7 places to the ranking.
    expect(ids(reads.slice(job.length))).toEqual(ids(dear.slice(0, 2)));

    // With 3 places for groups, the job's last 4 runs go back to the
    // ranking, and the ranking reads them by cost after the dearer runs.
    const capped = planFrameReads(runs, refs, new Map(), FRAME_READS_MAX, prompts, {
      groupSessions: 5,
      groupReads: 3,
    });
    expect(groupsOf(capped.reads.slice(0, 6))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(ids(capped.reads.slice(6))).toEqual([
      ...ids(dear),
      ...ids(job.slice(6)),
    ]);
    expect(capped.reads.slice(6).every((r) => r.group === undefined)).toBe(
      true,
    );
  });

  it("sizes the group reads by each run's model calls, and leaves the runs past the frame bound to the ranking", () => {
    // 10 runs of 3 calls at $0.50, and 5 runs of 5 calls at $0.10.
    const jobA = many("a", 10, 500_000n).map((r) => ({ ...r, modelCalls: 3 }));
    const jobB = many("b", 5, 100_000n).map((r) => ({ ...r, modelCalls: 5 }));
    const runs = [...jobA, ...jobB];
    const { reads, coverage } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([
        ["sha256:a", jobA],
        ["sha256:b", jobB],
      ]),
      { groupFrames: 10 },
    );
    // Job A's first 3 runs fit 10 frames, and a fourth would make 12. Job B's
    // first run needs 5 of the 1 left, so job B gets no group read.
    expect(ids(reads)).toEqual([...ids(jobA), ...ids(jobB)]);
    expect(groupsOf(reads)).toEqual([
      0,
      0,
      0,
      ...Array<null>(7 + jobB.length).fill(null),
    ]);
    expect(coverage).toMatchObject({ read: 15, capped: 0 });
  });

  it("groups runs as recurring runs groups them: by prompt source too, and never a person's prompt", () => {
    const sdk = many("sdk", RECURRING_RUNS_MIN, 320_000n);
    const typed = many("typed", RECURRING_RUNS_MIN, 320_000n);
    const hook = many("hook", RECURRING_RUNS_MIN - 1, 320_000n);
    const runs = [...sdk, ...typed, ...hook];
    // One digest, three sources. The digest alone would make one group of 14.
    const prompts = new Map<string, RunFirstPrompt>([
      ...sdk.map((r) => [r.runId, firstPrompt("sha256:d", "sdk")] as const),
      ...typed.map((r) => [r.runId, firstPrompt("sha256:d", "typed")] as const),
      ...hook.map((r) => [r.runId, firstPrompt("sha256:d", "hook")] as const),
    ]);
    const { reads } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      prompts,
    );
    expect(ids(reads.filter((r) => r.group !== undefined))).toEqual(ids(sdk));
  });

  it("reads no group when it has no place for one", () => {
    const job = many("job", 10, 320_000n);
    const { reads } = planFrameReads(
      job,
      everyRef(job),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([["sha256:job", job]]),
      { groupReads: 0 },
    );
    expect(ids(reads)).toEqual(ids(job));
    expect(reads.every((r) => r.group === undefined)).toBe(true);
  });

  it("takes two groups of one cost and size by job key, and each group's runs by rank", () => {
    const dear = many("dear", 300, 1_000_000n);
    // Within each group, the dearer run has the later id.
    const later = [
      planRun("tse_x0", 10_000n),
      planRun("tse_x1", 20_000n),
      planRun("tse_x2", 30_000n),
      planRun("tse_x3", 40_000n),
      planRun("tse_x4", 50_000n),
    ];
    const earlier = [
      planRun("tse_y0", 10_000n),
      planRun("tse_y1", 20_000n),
      planRun("tse_y2", 30_000n),
      planRun("tse_y3", 40_000n),
      planRun("tse_y4", 50_000n),
    ];
    const runs = [...dear, ...later, ...earlier];
    const { reads } = planFrameReads(
      runs,
      everyRef(runs),
      new Map(),
      FRAME_READS_MAX,
      promptsOf([
        ["sha256:b", later],
        ["sha256:a", earlier],
      ]),
    );
    expect(ids(reads.slice(0, 10))).toEqual([
      "tse_y4",
      "tse_y3",
      "tse_y2",
      "tse_y1",
      "tse_y0",
      "tse_x4",
      "tse_x3",
      "tse_x2",
      "tse_x1",
      "tse_x0",
    ]);
    expect(groupsOf(reads.slice(0, 10))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("keeps a ledger run out of a group read, since the read names root sessions", () => {
    const job = many("job", RECURRING_RUNS_MIN, 320_000n);
    const refs = everyRef(job);
    refs.set(job[0]!.runId, { kind: "ledger", runUuid: rootOf(999) });
    const { reads } = planFrameReads(
      job,
      refs,
      new Map(),
      FRAME_READS_MAX,
      promptsOf([["sha256:job", job]]),
    );
    expect(ids(reads)).toEqual([...ids(job.slice(1)), job[0]!.runId]);
    expect(groupsOf(reads)).toEqual([0, 0, 0, 0, null]);
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
        pricedFrames([], SCOPE.orgId, rows, SESSION).map(
          (f): [bigint | null, string] => [f.costMicros, f.key],
        ),
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

  // #5023: standing context's values quote the week's price per 1,000 tokens,
  // the price the tool and steering pages quote.
  it("reads the week's price per 1,000 tokens as of the pass's end and hands it to the detectors", async () => {
    const readWeeklyPrice = vi.fn(async () => ({
      perThousandMicros: 29_110_000n,
      currency: "USD",
      requests: 4_200,
      since: new Date(NOW.getTime() - 7 * 86_400_000),
    }));
    const deps = {
      now: () => NOW,
      readRuns: async () => [pricedRun()],
      readRootSessions: async () => new Map([[SESSION, RUN_ID]]),
      readToolCalls: async () => [],
      readFrames: async () => new Map<string, PricedRequestFrame[]>(),
      readDecisions: async () => new Map(),
      write: async () => 0,
    };
    await runFindingsPass(SCOPE, { ...deps, readWeeklyPrice });
    expect(readWeeklyPrice).toHaveBeenCalledWith(SCOPE, NOW);
    const seen: DetectInput | undefined =
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0];
    expect(seen?.weeklyContextPrice).toEqual({
      perThousandMicros: 29_110_000n,
      currency: "USD",
    });

    // A week the book could not price reaches the detectors as no price.
    await runFindingsPass(SCOPE, {
      ...deps,
      readWeeklyPrice: async () => null,
    });
    expect(
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0].weeklyContextPrice,
    ).toBeNull();

    // A pass with no price read hands the detectors none at all.
    await runFindingsPass(SCOPE, deps);
    expect(
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0],
    ).not.toHaveProperty("weeklyContextPrice");

    // A workspace with no runs in the window reads no price.
    const unread = vi.fn(async () => null);
    await runFindingsPass(SCOPE, {
      ...deps,
      readRuns: async () => [],
      readWeeklyPrice: unread,
    });
    expect(unread).not.toHaveBeenCalled();
  });

  it("lets a failed weekly price read fail the pass without writing", async () => {
    const write = vi.fn();
    await expect(
      runFindingsPass(SCOPE, {
        now: () => NOW,
        readRuns: async () => [pricedRun()],
        readRootSessions: async () => new Map([[SESSION, RUN_ID]]),
        readToolCalls: async () => [],
        readFrames: async () => new Map(),
        readDecisions: async () => new Map(),
        readWeeklyPrice: async () => {
          throw new Error("price book down");
        },
        write,
      }),
    ).rejects.toThrow("price book down");
    expect(write).not.toHaveBeenCalled();
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

  // #5168: a group read returns all of its runs' rows in one query.
  const grouped: FrameRead[] = runs.map((r) =>
    r.runId === "d" || r.runId === "e" ? r : { ...r, group: 0 },
  );
  const readGroup = (group: readonly FrameRead[]) =>
    Promise.resolve(
      new Map(group.map((r) => [r.runId, Array.from({ length: sizes[r.runId]! }, (_, i) => i)])),
    );

  it("reads a group's runs in one query, and admits them one by one while they fit", async () => {
    const reader = vi.fn(read);
    const groupReader = vi.fn(readGroup);
    const { rows, peak } = await readFrameRows(
      grouped,
      reader,
      8,
      2,
      groupReader,
    );
    // a (3) and b (4) fit 8, and c (5) would pass it, so the read stops
    // inside the group.
    expect([...rows.keys()]).toEqual(["a", "b"]);
    expect(peak).toBe(7);
    expect(groupReader).toHaveBeenCalledTimes(1);
    expect(groupReader.mock.calls[0]?.[0].map((r) => r.runId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // The run read in the same batch was read and dropped.
    expect(reader.mock.calls.map(([r]) => r.runId)).toEqual(["d"]);
  });

  it("reads every run of a group and the runs after it while they fit", async () => {
    const { rows, peak } = await readFrameRows(grouped, read, 14, 2, readGroup);
    expect([...rows.keys()]).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(14);
  });

  it("reads a group's runs one by one when the caller cannot read a group", async () => {
    const reader = vi.fn(read);
    const { rows } = await readFrameRows(grouped, reader, 14, 2);
    expect([...rows.keys()]).toEqual(["a", "b", "c", "d", "e"]);
    expect(reader).toHaveBeenCalledTimes(5);
  });

  it("admits a group's run the read returned no rows for as read, with no frames", async () => {
    const { rows } = await readFrameRows(
      grouped,
      read,
      14,
      2,
      async () => new Map(),
    );
    expect(rows.get("a")).toEqual([]);
    expect([...rows.keys()]).toEqual(["a", "b", "c", "d", "e"]);
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

describe("a pass's frame plan (#4594, #5168)", () => {
  /** Root session `i`, numbered from 1. */
  const rootOf = (i: number) =>
    `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
  const runOf = (n: number, costMicros: bigint): RunTotalsRecord => ({
    ...pricedRun(),
    runId: `tse_${String(n).padStart(22, "0")}`,
    costMicros,
  });
  const promptOf = (digest: string): RunFirstPrompt => ({
    at: new Date("2026-09-10T09:59:00.000Z"),
    atMicros: Date.parse("2026-09-10T09:59:00.000Z") * 1_000,
    digest,
    source: null,
    origin: null,
    commandName: null,
  });

  it("hands each run's first prompt to the plan, so a cheap recurring job is read in one group read ahead of 200 dearer runs", async () => {
    const dear = Array.from({ length: FRAME_READS_MAX + 10 }, (_, i) =>
      runOf(i + 1, 1_000_000n),
    );
    const job = Array.from({ length: RECURRING_RUNS_MIN }, (_, i) =>
      runOf(1_000 + i, 1_000n),
    );
    const runs = [...dear, ...job];
    const roots = new Map(runs.map((r, i) => [rootOf(i), r.runId]));
    const readFrames = vi.fn(
      async (_scope: unknown, _runs: readonly FrameRead[]) =>
        new Map<string, PricedRequestFrame[]>(),
    );
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => runs,
      readRootSessions: async () => roots,
      readToolCalls: async () => [],
      readFrames,
      readDecisions: async () => new Map(),
      readFirstPrompts: async () =>
        new Map(job.map((r) => [r.runId, promptOf("sha256:job")])),
      write: async () => 0,
    });
    const planned = readFrames.mock.calls[0]?.[1] ?? [];
    // The job takes one read, and the dearer runs the other 199.
    expect(planned).toHaveLength(job.length + FRAME_READS_MAX - 1);
    expect(planned.slice(0, job.length).map((r) => r.runId)).toEqual(
      job.map((r) => r.runId),
    );
    expect(planned.slice(0, job.length).map((r) => r.group)).toEqual(
      Array<number>(job.length).fill(0),
    );
  });

  /**
   * A pass over `dear` and the recurring `jobs`, with every run's frames
   * read through the store's own priced read. Each run has one model call:
   * $1.00 for a dear run, and `jobCost` for a job's run. Each job's runs are
   * sealed, made no tool call, and changed no file.
   */
  async function passOver(
    dear: readonly RunTotalsRecord[],
    jobs: readonly (readonly RunTotalsRecord[])[],
  ) {
    const runs = [...dear, ...jobs.flat()];
    const roots = new Map(runs.map((r, i) => [rootOf(i), r.runId]));
    const rootByRun = new Map([...roots].map(([root, id]) => [id, root]));
    const costOf = new Map(runs.map((r) => [r.runId, r.costMicros]));
    const runByRoot = roots;
    const frameOf = (root: string) =>
      frameRow({
        at: "2026-09-10T10:00:00.500000Z",
        sessionUuid: root,
        seq: 1,
        reportedCostMicros: String(costOf.get(runByRoot.get(root)!)),
      });
    vi.mocked(loadPriceBookSlice).mockClear();
    vi.mocked(readModelCallFrames).mockReset();
    vi.mocked(readModelCallFrames).mockImplementation(async ({ run }) =>
      run.kind === "tacho" ? [frameOf(run.rootSessionUuid)] : [],
    );
    vi.mocked(readGroupModelCallFrames).mockReset();
    vi.mocked(readGroupModelCallFrames).mockImplementation(async ({ runs }) =>
      new Map(runs.map((r) => [r.rootSessionUuid, [frameOf(r.rootSessionUuid)]])),
    );
    vi.mocked(detectFindings).mockClear();
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const jobRuns = jobs.flat();
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => runs,
      readRootSessions: async () => roots,
      readToolCalls: async () => [],
      readFrames: (scope, reads) =>
        readPricedFrames(scope, reads, FRAME_READ_MAX_FRAMES, true),
      readDecisions: async () => new Map(),
      readFirstPrompts: async () =>
        new Map(
          jobs.flatMap((job, i) =>
            job.map((r) => [r.runId, promptOf(`sha256:job${i}`)] as const),
          ),
        ),
      readFileChanges: async () =>
        new Map(jobRuns.map((r) => [r.runId, false])),
      write,
    });
    const seen: DetectInput | undefined =
      vi.mocked(detectFindings).mock.calls.at(-1)?.[0];
    return {
      drafts: write.mock.calls[0]?.[3] ?? [],
      seen,
      rootByRun,
    };
  }

  /** `n` sealed runs of one job, from `first` on, each at `costMicros`. */
  const jobOf = (first: number, n: number, costMicros: bigint, agent: string) =>
    Array.from({ length: n }, (_, i) => {
      const r = runOf(first + i, costMicros);
      return {
        ...r,
        agentKey: agent,
        sealedAt: new Date(r.startedAt.getTime() + 10 * 60_000),
        toolCalls: 0,
        modelCalls: 1,
      };
    });

  // #5168, the Definition of done: the run reserve read 50 of this job's 400
  // runs, so 12.5% of its calls were priced and the pass wrote nothing.
  it("writes a recurring runs finding for a 400-run job behind 300 dearer runs", async () => {
    const dear = Array.from({ length: 300 }, (_, i) =>
      runOf(i + 1, 1_000_000n),
    );
    const job = jobOf(10_000, 400, 320_000n, "acme.ops.nightly");
    const { drafts, seen } = await passOver(dear, [job]);

    // One query read the whole job.
    expect(readGroupModelCallFrames).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readGroupModelCallFrames).mock.calls[0]?.[0].runs).toHaveLength(
      400,
    );
    expect(seen?.frameCoverage).toEqual({
      runs: 700,
      read: 400 + FRAME_READS_MAX - 1,
      capped: 300 - (FRAME_READS_MAX - 1),
      unmatched: 0,
    });
    const recurring = drafts.filter((d) => d.kind === "recurring_runs");
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({
      level: "agent",
      subject: "acme.ops.nightly",
      savingMicros: 400n * 320_000n,
    });
    // Each of the job's frames is claimed once, under detector 7.
    const claims = recurring[0]!.claims ?? [];
    expect(claims).toHaveLength(400);
    expect(claims.every((c) => c.detector === 7)).toBe(true);
    expect(new Set(claims.map((c) => c.runId))).toEqual(
      new Set(job.map((r) => r.runId)),
    );
  });

  // #5168, the Definition of done: the bound decision 12 sets.
  it(`keeps a pass within ${FRAME_READS_MAX} queries, ${FRAME_GROUP_READS_RESERVE} of them group reads, and ${FRAME_READ_MAX_FRAMES} frames`, async () => {
    const dear = Array.from({ length: 300 }, (_, i) =>
      runOf(i + 1, 1_000_000n),
    );
    // The spec's sample job, about 2,500 runs a month, and 59 small jobs.
    const big = jobOf(10_000, 2_500, 320_000n, "acme.ops.nightly");
    const small = Array.from({ length: 59 }, (_, j) =>
      jobOf(20_000 + j * 10, RECURRING_RUNS_MIN, 10_000n - BigInt(j), `acme.ops.small${j}`),
    );
    const { seen, rootByRun } = await passOver(dear, [big, ...small]);

    const groupCalls = vi.mocked(readGroupModelCallFrames).mock.calls;
    const runCalls = vi.mocked(readModelCallFrames).mock.calls;
    expect(groupCalls).toHaveLength(FRAME_GROUP_READS_RESERVE);
    expect(groupCalls.length + runCalls.length).toBe(FRAME_READS_MAX);
    // The 2,500-run job is one query.
    expect(groupCalls[0]?.[0].runs.map((r) => r.rootSessionUuid)).toEqual(
      big.map((r) => rootByRun.get(r.runId)),
    );
    for (const [args] of groupCalls) {
      const sessions = new Set(args.runs.flatMap((r) => r.sessionUuids));
      expect(sessions.size).toBeLessThanOrEqual(FRAME_GROUP_READ_SESSIONS);
    }
    // The pass holds no more frames than the cap.
    let held = 0;
    for (const list of seen?.frames?.values() ?? []) held += list.length;
    expect(held).toBeLessThanOrEqual(FRAME_READ_MAX_FRAMES);
    // The big job and 49 small jobs take the group reads. The other 10 small
    // jobs' runs go to the ranking, where the 150 places left go to dearer
    // runs.
    expect(seen?.frameCoverage).toEqual({
      runs: 300 + 2_500 + 59 * RECURRING_RUNS_MIN,
      read: 2_500 + 49 * RECURRING_RUNS_MIN + (FRAME_READS_MAX - FRAME_GROUP_READS_RESERVE),
      capped:
        10 * RECURRING_RUNS_MIN + 300 - (FRAME_READS_MAX - FRAME_GROUP_READS_RESERVE),
      unmatched: 0,
    });
    // Every detector runs over 3,095 runs, so this test gets more time.
  }, 30_000);
});

describe("group reads in the priced read (#5168)", () => {
  const A = "tse_a";
  const B = "tse_b";
  const ROOT_A = "00000000-0000-4000-8000-00000000000a";
  const ROOT_B = "00000000-0000-4000-8000-00000000000b";
  const CHILD_A = "00000000-0000-4000-8000-0000000000ac";
  const rowsA = [
    // Two chains' calls at one instant, which only the chain and seq order.
    frameRow({ at: "2026-09-10T10:00:00.500000Z", sessionUuid: CHILD_A, seq: 3 }),
    frameRow({ at: "2026-09-10T10:00:00.500000Z", sessionUuid: ROOT_A, seq: 7 }),
    frameRow({ at: "2026-09-10T10:00:01.500000Z", sessionUuid: ROOT_A, seq: 8 }),
  ];
  const rowsB = [
    frameRow({ at: "2026-09-10T10:00:00.500000Z", sessionUuid: ROOT_B, seq: 1 }),
  ];
  const refA = tachoRef(ROOT_A, CHILD_A);
  const refB = tachoRef(ROOT_B);

  function mockStore() {
    vi.mocked(readModelCallFrames).mockReset();
    vi.mocked(readModelCallFrames).mockImplementation(async ({ run }) =>
      run.kind === "tacho" && run.rootSessionUuid === ROOT_A ? rowsA : rowsB,
    );
    vi.mocked(readGroupModelCallFrames).mockReset();
    vi.mocked(readGroupModelCallFrames).mockImplementation(
      async () =>
        new Map([
          [ROOT_A, rowsA],
          [ROOT_B, rowsB],
        ]),
    );
  }

  it("gives each frame the key a read of its run alone gives it", async () => {
    mockStore();
    const alone = await readPricedFrames(SCOPE, [
      { runId: A, ref: refA },
      { runId: B, ref: refB },
    ]);
    const grouped = await readPricedFrames(SCOPE, [
      { runId: A, ref: refA, group: 0 },
      { runId: B, ref: refB, group: 0 },
    ]);
    expect(readGroupModelCallFrames).toHaveBeenCalledTimes(1);
    expect(readGroupModelCallFrames).toHaveBeenCalledWith({
      ...SCOPE,
      runs: [refA, refB],
    });
    expect(grouped).toEqual(alone);
    expect(grouped.get(A)?.map((f) => f.key)).toEqual([
      `2026-09-10T10:00:00.500000Z#${ROOT_A}:7`,
      `2026-09-10T10:00:00.500000Z#${CHILD_A}:3`,
      `2026-09-10T10:00:01.500000Z#${ROOT_A}:8`,
    ]);
    // The subagent's frame names its chain, and the root's own frames none.
    expect(grouped.get(A)?.map((f) => f.sessionUuid)).toEqual([
      null,
      CHILD_A,
      null,
    ]);
  });

  it("asks the group read for calls that named no model only for the pass", async () => {
    mockStore();
    const reads: FrameRead[] = [
      { runId: A, ref: refA, group: 0 },
      { runId: B, ref: refB, group: 0 },
    ];
    await readPricedFrames(SCOPE, reads, 10, true);
    expect(readGroupModelCallFrames).toHaveBeenLastCalledWith({
      ...SCOPE,
      runs: [refA, refB],
      keepModelless: true,
    });
    expect(readModelCallFrames).not.toHaveBeenCalled();
  });

  it("reads two group numbers as two queries, and a run with no group alone", async () => {
    mockStore();
    const C = "tse_c";
    const out = await readPricedFrames(SCOPE, [
      { runId: A, ref: refA, group: 0 },
      { runId: B, ref: refB, group: 1 },
      { runId: C, ref: refB },
    ]);
    expect(readGroupModelCallFrames).toHaveBeenCalledTimes(2);
    expect(readModelCallFrames).toHaveBeenCalledTimes(1);
    expect([...out.keys()]).toEqual([A, B, C]);
  });
});

describe("instruction proposals in a pass (#4579)", () => {
  /** A run of the window, started at `startedAt`, by `pricedRun`'s agent. */
  const runAt = (n: number, startedAt: string): RunTotalsRecord => ({
    ...pricedRun(),
    runId: `tse_${String(n).padStart(22, "0")}`,
    startedAt: new Date(startedAt),
  });
  /** A run's first prompt, sent a minute after the run started. */
  const promptOf = (run: RunTotalsRecord, text: string): RunPrompt => {
    const at = new Date(run.startedAt.getTime() + 60_000);
    return {
      runId: run.runId,
      seq: 1,
      at,
      atMicros: at.getTime() * 1_000,
      digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      length: text.length,
      text,
    };
  };
  /** The lineage a sentence's proposal names, from the sentence's key. */
  const lineageOf = (sentence: string) =>
    instructionLineage(
      createHash("sha256")
        .update(sentence.toLowerCase().replace(/[.!?;:,]+$/, ""))
        .digest("hex"),
    );

  /**
   * One pass over the runs and their prompts, and what the opener received.
   * `taken` installs the taken read: a set it answers, or an error it throws.
   */
  async function pass(
    runs: readonly RunTotalsRecord[],
    prompts: readonly RunPrompt[],
    options: {
      decisions?: ReadonlyMap<string, Date>;
      taken?: ReadonlySet<string> | Error;
      mode?: PromptRead["mode"];
    } = {},
  ) {
    const openProposals = vi.fn(
      async (_scope: unknown, _input: SpendProposalInput) => undefined,
    );
    const readTakenLineages = vi.fn(async (): Promise<ReadonlySet<string>> => {
      if (options.taken instanceof Error) throw options.taken;
      return options.taken ?? new Set<string>();
    });
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [...runs],
      readRootSessions: async () => new Map(),
      readToolCalls: async () => [],
      readFrames: async () => new Map(),
      readDecisions: async () => new Map<string, Date>(options.decisions ?? []),
      readPrompts: async () => ({
        mode: options.mode ?? "content_exact",
        prompts,
        frames: new Map(),
      }),
      openProposals,
      ...(options.taken === undefined ? {} : { readTakenLineages }),
      write: async () => 0,
    });
    // The pass calls an installed opener on every pass, so an empty list
    // below is what the opener received, not a missed call.
    expect(openProposals).toHaveBeenCalledOnce();
    const instructions = openProposals.mock.calls[0]![1].instructions;
    return {
      instructions,
      lineages: instructions.map((p) => p.lineageId),
      readTakenLineages,
    };
  }

  it("opens proposals for the 5 instructions ranked past 20 taken lineages", async () => {
    const sentences = Array.from(
      { length: 25 },
      (_, i) => `Please follow rule ${i + 1} of the team handbook.`,
    );
    const runs = [1, 2, 3, 4].map((n) =>
      runAt(n, `2026-09-0${n}T10:00:00.000Z`),
    );
    // Four runs receive the first 20 sentences and three runs the other 5, so
    // the first 20 rank first.
    const prompts = runs.map((run, i) =>
      promptOf(run, (i < 3 ? sentences : sentences.slice(0, 20)).join("\n")),
    );
    const taken = new Set(sentences.slice(0, 20).map(lineageOf));
    const rest = sentences.slice(20).map(lineageOf);

    // Without the read, the pass hands the opener the 20 taken lineages, and
    // the opener refuses each one.
    const blind = await pass(runs, prompts);
    expect([...blind.lineages].sort()).toEqual([...taken].sort());

    const { lineages, readTakenLineages } = await pass(runs, prompts, {
      taken,
    });
    expect(readTakenLineages).toHaveBeenCalledWith(SCOPE);
    expect([...lineages].sort()).toEqual([...rest].sort());
  });

  it("keeps a dismissal on the runs before it, and opens a proposal once 3 later runs repeat the instruction", async () => {
    const text = "Run the full test suite before you open a pull request.";
    const decisions = new Map([
      [
        findingFingerprint("repeated_instructions", "agent", "acme.core.cc"),
        new Date("2026-09-05T00:00:00.000Z"),
      ],
    ]);
    const before = [1, 2, 3].map((n) =>
      runAt(n, `2026-09-0${n}T10:00:00.000Z`),
    );
    const after = [6, 7, 8].map((n) =>
      runAt(n, `2026-09-0${n}T10:00:00.000Z`),
    );
    const promptsOf = (runs: readonly RunTotalsRecord[]) =>
      runs.map((r) => promptOf(r, text));
    const taken = new Set<string>();

    // With no decision, the three runs open a proposal.
    expect((await pass(before, promptsOf(before), { taken })).lineages).toEqual(
      [lineageOf(text)],
    );
    // The dismissal covers them.
    expect(
      (await pass(before, promptsOf(before), { taken, decisions })).lineages,
    ).toEqual([]);
    // Two later runs are too few.
    const two = [...before, ...after.slice(0, 2)];
    expect(
      (await pass(two, promptsOf(two), { taken, decisions })).lineages,
    ).toEqual([]);
    // Three later runs open one, which only the later runs support.
    const all = [...before, ...after];
    const { instructions } = await pass(all, promptsOf(all), {
      taken,
      decisions,
    });
    expect(instructions).toEqual([
      expect.objectContaining({
        lineageId: lineageOf(text),
        runs: after.map((r) => r.runId),
      }),
    ]);
  });

  it("proposes without the taken lineages when their read fails", async () => {
    const sentences = Array.from(
      { length: 25 },
      (_, i) => `Please follow rule ${i + 1} of the team handbook.`,
    );
    const runs = [1, 2, 3].map((n) =>
      runAt(n, `2026-09-0${n}T10:00:00.000Z`),
    );
    const prompts = runs.map((run) => promptOf(run, sentences.join("\n")));
    const { lineages, readTakenLineages } = await pass(runs, prompts, {
      taken: new Error("postgres down"),
    });
    expect(readTakenLineages).toHaveBeenCalledOnce();
    // The pass still hands the opener its first 20, which the opener checks
    // against its own tables.
    expect(lineages).toHaveLength(20);
  });

  it("reads no taken lineages on a digest_only workspace, which gets no instruction proposals", async () => {
    const runs = [1, 2, 3].map((n) =>
      runAt(n, `2026-09-0${n}T10:00:00.000Z`),
    );
    const text = "Run the full test suite before you open a pull request.";
    const { lineages, readTakenLineages } = await pass(
      runs,
      runs.map((r) => promptOf(r, text)),
      { taken: new Set(), mode: "digest_only" },
    );
    expect(lineages).toEqual([]);
    expect(readTakenLineages).not.toHaveBeenCalled();
  });
});
