/**
 * run-record: the tenant read path the export and summarize jobs share.
 * Every read runs inside the run's tenant scope; the wrapped-session select
 * fences on the public id, the org and the workspace; an unsegmented ledger
 * seal refuses to export.
 */
import { schema } from "@oxagen/database";
import {
  type ChainCursor,
  flattenEvent,
  GENESIS_CURSOR,
  hashEvent,
  type JsonValue,
  sealEvent,
  type UnsealedTachoEvent,
  wrappedFrameOf,
} from "@oxagen/tacho";
import type { TachoEventRecord, TachoFrameRow } from "@oxagen/telemetry";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  createPostgresRunStore: vi.fn(),
  getSegment: vi.fn(),
  selectTachoEvents: vi.fn(),
  selectTachoEventRecords: vi.fn(),
  selectTachoSubagentEvents: vi.fn(),
  unflattenEventReading: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...(await importOriginal<typeof import("@oxagen/database")>()),
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/run-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/run-ledger")>()),
  createPostgresRunStore: mocks.createPostgresRunStore,
}));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ getSegment: mocks.getSegment }),
}));
// The real function, wrapped so a test can read what the export passed it.
vi.mock("@oxagen/tacho", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/tacho")>()),
  unflattenEventReading: mocks.unflattenEventReading,
}));
const { unflattenEventReading: realUnflattenEventReading } =
  await vi.importActual<typeof import("@oxagen/tacho")>("@oxagen/tacho");
vi.mock("@oxagen/telemetry", () => ({
  selectTachoEvents: mocks.selectTachoEvents,
  selectTachoEventRecords: mocks.selectTachoEventRecords,
  selectTachoSubagentEvents: mocks.selectTachoSubagentEvents,
}));

import {
  readRunFrames,
  readSealedSegments,
  readTranscriptFramesOf,
  resolveRunRecord,
  runFramePages,
} from "./run-record";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
};
const OTHER_WORKSPACE = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const SESSION = "0192d4a8-7c1e-7a00-8000-00000000c0de";

function tachoRow(seq: number): TachoFrameRow {
  return {
    seq,
    ts: "2026-09-11 09:00:00.000",
    eventId: `evt_${String(seq).padStart(26, "0")}`,
    kind: "tool_call",
    prevHash: `sha256:${String(Math.max(seq - 1, 0)).padStart(64, "0")}`,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    body: "{}",
    toolName: "Read",
    toolStatus: "ok",
    toolUseId: `tu_${seq}`,
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
  } as TachoFrameRow;
}

const scopes: unknown[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  scopes.length = 0;
  mocks.runInTenantScope.mockImplementation(
    (scope: unknown, fn: () => unknown) => {
      scopes.push(scope);
      return fn();
    },
  );
  mocks.unflattenEventReading.mockImplementation(realUnflattenEventReading);
});

describe("resolveRunRecord", () => {
  const db = drizzle.mock({ schema });

  /** Answers `rows` for the select, recording the SQL it compiled. */
  function selectAnswering(rows: unknown[]) {
    const compiled: Array<{ sql: string; params: unknown[] }> = [];
    mocks.withTenantDb.mockImplementation(
      (
        fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } },
      ) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve(rows);
      },
    );
    return compiled;
  }

  it("reads a wrapped session inside the tenant scope, fenced on public id, org and workspace", async () => {
    const compiled = selectAnswering([
      {
        sessionUuid: SESSION,
        enforcementTier: "gateway",
        completenessGaps: ["tool_bodies", 3],
        replayGrade: "view",
      },
    ]);
    const record = await resolveRunRecord(SCOPE, "tse_4q8r1t6v3x5z0b2d7h2k9m");
    expect(record).toEqual({
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "gateway",
      completenessGaps: ["tool_bodies"],
      replayGrade: "view",
    });
    expect(scopes).toEqual([SCOPE]);
    const [query] = compiled;
    expect(query?.sql).toMatch(/"sessions"\."public_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."org_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."workspace_id" = \$\d+/);
    expect(query?.params).toEqual(
      expect.arrayContaining([
        "tse_4q8r1t6v3x5z0b2d7h2k9m",
        SCOPE.orgId,
        SCOPE.workspaceId,
      ]),
    );
  });

  it("answers null for a session the select does not find in another workspace (negative)", async () => {
    const compiled = selectAnswering([]);
    const other = { ...SCOPE, workspaceId: OTHER_WORKSPACE };
    expect(await resolveRunRecord(other, "tse_4q8r1t6v3x5z0b2d7h2k9m")).toBe(
      null,
    );
    expect(compiled[0]?.params).toContain(OTHER_WORKSPACE);
    expect(compiled[0]?.params).not.toContain(SCOPE.workspaceId);
  });

  it("reads a ledger run through the ledger store inside the scope, and answers null when the store has none (negative)", async () => {
    const attempts = [{ attemptId: "a1" }];
    mocks.createPostgresRunStore.mockReturnValue({
      getRunByPublicId: (id: string) =>
        Promise.resolve(id === "arun_known" ? { runId: "r1" } : null),
      listRunAttempts: () => Promise.resolve(attempts),
    });
    expect(await resolveRunRecord(SCOPE, "arun_known")).toEqual({
      source: "ledger",
      runId: "r1",
      attempts,
    });
    expect(await resolveRunRecord(SCOPE, "arun_unknown")).toBe(null);
    expect(scopes).toEqual([SCOPE, SCOPE]);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe("readSealedSegments", () => {
  it("refuses a ledger seal the recorder never segmented (negative)", async () => {
    const record = {
      source: "ledger" as const,
      runId: "r1",
      attempts: [
        {
          attemptId: "a1",
          attemptPublicId: "arat_0123456789abcdefghjkmn",
          attemptNumber: 1,
          seal: { archiveSegmentRef: null, merkleRoot: null },
        },
      ],
    } as unknown as Parameters<typeof readSealedSegments>[1];
    await expect(readSealedSegments(SCOPE, record)).rejects.toThrow(
      /arat_0123456789abcdefghjkmn sealed before the recorder graded it/,
    );
    expect(mocks.getSegment).not.toHaveBeenCalled();
    expect(scopes).toEqual([SCOPE]);
  });

  it("builds a wrapped session's one segment from every row, paging past the first 500", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => tachoRow(i));
    mocks.selectTachoEventRecords.mockImplementation(
      ({ afterSeq, limit }: { afterSeq: number; limit: number }) =>
        Promise.resolve(
          rows
            .filter((r) => r.seq > afterSeq)
            .slice(0, limit)
            .map((frame) => ({ frame, envelope: {} })),
        ),
    );
    const [segment] = await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "gateway",
      completenessGaps: [],
      replayGrade: "view",
    });
    expect(segment?.frameCount).toBe(501);
    expect(segment?.digests.at(-1)).toBe(rows[500]?.hash);
    expect(
      mocks.selectTachoEventRecords.mock.calls.map((c) => c[0].afterSeq),
    ).toEqual([-1, 499]);
    expect(
      mocks.selectTachoEventRecords.mock.calls.every(
        (c) => c[0].sessionUuid === SESSION,
      ),
    ).toBe(true);
    // No row here rebuilds its event, so every frame is the row's projection.
    expect(
      segment?.envelopes.every(
        (e) => (e as Record<string, unknown>)["event"] === undefined,
      ),
    ).toBe(true);
  });

  it("carries each event its stored row rebuilds, and leaves out one it cannot prove (#3733)", async () => {
    const event = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: SESSION,
        root_session_uuid: SESSION,
        ts: "2026-09-11T09:00:00.000Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
        },
        turn: { turn_seq: 1 },
        kind: "tool_call",
        body: { tool_name: "Read", tool_status: "ok" },
      } as UnsealedTachoEvent,
      GENESIS_CURSOR,
    ).event;
    const { bytes_ref: _serverOwned, ...envelope } = flattenEvent(event);
    const proven: TachoEventRecord = {
      frame: {
        ...tachoRow(0),
        hash: event.hash,
        bytesRef: "evb:v1:k1:" + "a".repeat(64),
      },
      envelope,
    };
    // The row says Read; the sealed event said Write. No reading hashes to
    // the chain's hash, so the export does not carry an event for it.
    const unproven: TachoEventRecord = {
      frame: tachoRow(1),
      envelope: {
        ...envelope,
        seq: 1,
        body: JSON.stringify({ tool_name: "Write" }),
      },
    };
    mocks.selectTachoEventRecords.mockResolvedValue([proven, unproven]);
    const [segment] = await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "harness",
      completenessGaps: [],
      replayGrade: null,
    });
    const [carried, bare] = (segment?.envelopes ?? []) as Array<
      Record<string, unknown>
    >;
    expect(carried?.["event"]).toEqual(event);
    expect(carried?.["ts"]).toBe("2026-09-11T09:00:00.000Z");
    expect(carried?.["content"]).toEqual({
      digest: null,
      bytes_ref: "evb:v1:k1:" + "a".repeat(64),
      redactions: [],
    });
    expect(hashEvent(carried?.["event"] as Record<string, unknown>)).toBe(
      carried?.["hash"],
    );
    expect(bare?.["event"]).toBeUndefined();
    expect(bare?.["tool_name"]).toBe("Read");
  });

  it("carries an event rebuilt from the row as ClickHouse reads it, with no bytes_ref when none was kept (#3733)", async () => {
    const event = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: SESSION,
        root_session_uuid: SESSION,
        ts: "2026-09-11T09:00:00Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
        },
        turn: { turn_seq: 4 },
        harness_event_sequence: 11,
        kind: "tool_call",
        body: { tool_name: "Read", tool_status: "ok" },
      } as UnsealedTachoEvent,
      GENESIS_CURSOR,
    ).event;
    const { bytes_ref: _serverOwned, ...flat } = flattenEvent(event);
    // UInt64 and Nullable(UInt32) read back as JSON text, ts as toString(ts).
    const envelope = {
      ...flat,
      seq: "0",
      ts: "2026-09-11 09:00:00.000",
      turn_seq: "4",
      harness_event_sequence: "11",
    };
    mocks.selectTachoEventRecords.mockResolvedValue([
      { frame: { ...tachoRow(0), hash: event.hash, bytesRef: "" }, envelope },
    ]);
    const [segment] = await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "harness",
      completenessGaps: [],
      replayGrade: null,
    });
    const [carried] = (segment?.envelopes ?? []) as Array<
      Record<string, JsonValue>
    >;
    expect(carried?.["event"]).toEqual(event);
    expect(carried?.["ts"]).toBe("2026-09-11T09:00:00Z");
    expect(carried?.["turn_seq"]).toBe(4);
    expect(carried?.["content"]).toEqual({
      digest: null,
      bytes_ref: null,
      redactions: [],
    });
    // The frame is exactly what a verifier rebuilds from the event it carries.
    expect(carried).toEqual(
      wrappedFrameOf(carried?.["event"] as Record<string, JsonValue>, null),
    );
  });

  // #3814: each row used to search every reading it leaves open, although
  // the rows of one session mostly share one.
  it("tries the reading that rebuilt a row first on the session's next row", async () => {
    // Both events sent an empty `host` group and a whole-second ts, so a row
    // rebuilds them only with those two readings flipped.
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events = [
      { tool_name: "Read", tool_status: "ok" },
      { tool_name: "Bash", tool_status: "ok" },
    ].map((body) => {
      const sealed = sealEvent(
        {
          v: "tacho/1.0",
          event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          session_id: "sess-1",
          session_uuid: SESSION,
          root_session_uuid: SESSION,
          ts: "2026-09-11T09:00:00Z",
          fidelity: "sdk",
          source: "hook",
          agent: {
            agent_key: "acme.core.cc-laptop",
            fleet_id: "wrk_1",
            runtime: "claude-code",
            harness: "claude-code",
            wrapper_version: "2.1.1",
          },
          turn: { turn_seq: 1 },
          host: {},
          kind: "tool_call",
          body,
        } as UnsealedTachoEvent,
        cursor,
      );
      cursor = sealed.next;
      return sealed.event;
    });
    const records: TachoEventRecord[] = events.map((event, seq) => {
      const { bytes_ref: _serverOwned, ...flat } = flattenEvent(event);
      return {
        frame: { ...tachoRow(seq), hash: event.hash },
        envelope: { ...flat, ts: "2026-09-11 09:00:00.000" },
      };
    });
    mocks.selectTachoEventRecords.mockResolvedValue(records);
    const [segment] = await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "harness",
      completenessGaps: [],
      replayGrade: null,
    });
    expect(
      (segment?.envelopes ?? []).map(
        (frame) => (frame as Record<string, unknown>)["event"],
      ),
    ).toEqual(events);
    const calls = mocks.unflattenEventReading.mock.calls;
    const results = mocks.unflattenEventReading.mock.results.map(
      (result) => result.value as { reading: unknown; tried: number },
    );
    expect(calls).toHaveLength(2);
    // The first row has nothing to carry and searches.
    expect(calls[0]?.[1]).toEqual({ first: null });
    expect(results[0]?.reading).toEqual(["group:host", "ts:whole_second"]);
    expect(results[0]?.tried).toBeGreaterThan(1);
    // The second row is handed that reading and matches on it at once.
    expect(calls[1]?.[1]).toEqual({ first: results[0]?.reading });
    expect(results[1]?.tried).toBe(1);
  });

  it("keeps carrying the last reading that matched past a row no reading rebuilds (negative)", async () => {
    const event = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: SESSION,
        root_session_uuid: SESSION,
        ts: "2026-09-11T09:00:00Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
        },
        turn: { turn_seq: 1 },
        kind: "tool_call",
        body: { tool_name: "Read", tool_status: "ok" },
      } as UnsealedTachoEvent,
      GENESIS_CURSOR,
    ).event;
    const { bytes_ref: _serverOwned, ...flat } = flattenEvent(event);
    const envelope = { ...flat, ts: "2026-09-11 09:00:00.000" };
    const matching: TachoEventRecord = {
      frame: { ...tachoRow(0), hash: event.hash },
      envelope,
    };
    // The row says Write where the sealed event said Read.
    const unproven: TachoEventRecord = {
      frame: tachoRow(1),
      envelope: { ...envelope, body: JSON.stringify({ tool_name: "Write" }) },
    };
    mocks.selectTachoEventRecords.mockResolvedValue([
      matching,
      unproven,
      matching,
    ]);
    await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "harness",
      completenessGaps: [],
      replayGrade: null,
    });
    const calls = mocks.unflattenEventReading.mock.calls;
    const first = (
      mocks.unflattenEventReading.mock.results[0]?.value as {
        reading: unknown;
      }
    ).reading;
    expect(first).toEqual(["ts:whole_second"]);
    expect(calls[1]?.[1]).toEqual({ first });
    expect(calls[2]?.[1]).toEqual({ first });
  });
});

/**
 * A `tacho_events` store holding these seqs. It answers a read the way the
 * ClickHouse select does: after `afterSeq`, through `throughSeq` when given,
 * ascending, at most `limit`.
 */
function tachoChain(seqs: number[]) {
  mocks.selectTachoEvents.mockImplementation(
    async (args: { afterSeq: number; throughSeq?: number; limit: number }) =>
      seqs
        .filter(
          (seq) =>
            seq > args.afterSeq &&
            (args.throughSeq === undefined || seq <= args.throughSeq),
        )
        .slice(0, args.limit)
        .map(tachoRow),
  );
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Only `source` is narrowed: RunRecord's completenessGaps is a mutable
// string[], which a readonly `as const` tuple cannot be passed as.
const WRAPPED = {
  source: "tacho" as const,
  sessionUuid: SESSION,
  enforcementTier: "harness",
  completenessGaps: [] as string[],
  replayGrade: null,
};

describe("readRunFrames", () => {
  it("reads a wrapped session's frames in sequence inside the tenant scope", async () => {
    tachoChain([0, 1]);
    const frames = await readRunFrames(SCOPE, WRAPPED);
    expect(frames.map((f) => f.seq)).toEqual(["0", "1"]);
    expect(scopes).toEqual([SCOPE]);
  });

  // #4202: under FINAL an unbounded page scans the rest of the chain.
  it("bounds each windowed page of a wrapped session at afterSeq plus the page size", async () => {
    tachoChain(range(0, 1200));
    const frames = await readRunFrames(SCOPE, WRAPPED);
    expect(frames.map((f) => Number(f.seq))).toEqual(range(0, 1200));
    const calls = mocks.selectTachoEvents.mock.calls.map(
      ([args]) => args as { afterSeq: number; throughSeq?: number },
    );
    const windowed = calls.filter((c) => c.throughSeq !== undefined);
    expect(windowed.map((c) => c.afterSeq)).toEqual([-1, 499, 999]);
    for (const call of windowed) {
      expect(call.throughSeq).toBe(call.afterSeq + 500);
    }
    // One unbounded read, past the last window, finds the end of the chain.
    expect(calls.filter((c) => c.throughSeq === undefined)).toEqual([
      expect.objectContaining({ afterSeq: 1499 }),
    ]);
  });

  it("reads past a recorded break in a wrapped session's chain", async () => {
    const seqs = [...range(0, 299), ...range(800, 1000)];
    tachoChain(seqs);
    const frames = await readRunFrames(SCOPE, WRAPPED);
    expect(frames.map((f) => Number(f.seq))).toEqual(seqs);
  });

  it("reads a wrapped session one frame past a full page", async () => {
    tachoChain(range(0, 500));
    const frames = await readRunFrames(SCOPE, WRAPPED);
    expect(frames.map((f) => Number(f.seq))).toEqual(range(0, 500));
  });

  it("reads an empty wrapped session as no frames (negative)", async () => {
    tachoChain([]);
    expect(await readRunFrames(SCOPE, WRAPPED)).toEqual([]);
  });
});

// #3784: the enrichment job read every frame of a run into one array before
// it read any text. It now pulls pages and stops at its ceiling.
describe("runFramePages", () => {
  /** Every page a reader pulls to the end, as frame seqs. */
  async function pagesOf(record: Parameters<typeof runFramePages>[1]) {
    const pages: number[][] = [];
    for await (const page of runFramePages(SCOPE, record))
      pages.push(page.map((frame) => Number(frame.seq)));
    return pages;
  }

  it("reads a wrapped session a page at a time, each inside the tenant scope", async () => {
    tachoChain(range(0, 1200));
    const pages = await pagesOf(WRAPPED);
    expect(pages.map((page) => page.length)).toEqual([500, 500, 201]);
    expect(pages.flat()).toEqual(range(0, 1200));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope === SCOPE)).toBe(true);
  });

  it("reads no further page once the reader stops", async () => {
    tachoChain(range(0, 1200));
    const pages = runFramePages(SCOPE, WRAPPED);
    const first = await pages.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(500);
    await pages.return(undefined);
    expect(mocks.selectTachoEvents).toHaveBeenCalledTimes(1);
  });

  it("reads past a recorded break in a wrapped session's chain", async () => {
    const seqs = [...range(0, 299), ...range(800, 1000)];
    tachoChain(seqs);
    expect((await pagesOf(WRAPPED)).flat()).toEqual(seqs);
  });

  it("reads a ledger run's events a page at a time from each page's last run_seq", async () => {
    const event = (runSeq: number) => ({
      runSeq: String(runSeq),
      eventType: "admission.run_admitted",
      stage: "admission",
      observedAt: "2026-09-25T12:00:00.000Z",
      eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
      payload: {},
      body: {
        bodyRef: null,
        bodyDigest: null,
        bodyBytes: null,
        redactions: null,
        fidelity: "digest_only",
      },
    });
    const events = range(1, 503).map(event);
    const readAttemptEventsSince = vi.fn(
      (_runId: string, after: string, limit: number) =>
        Promise.resolve(
          events
            .filter((e) => Number(e.runSeq) > Number(after))
            .slice(0, limit),
        ),
    );
    mocks.createPostgresRunStore.mockReturnValue({ readAttemptEventsSince });
    const pages = await pagesOf({ source: "ledger", runId: "r1", attempts: [] });
    expect(pages.map((page) => page.length)).toEqual([500, 3]);
    expect(pages.flat()).toEqual(range(1, 503));
    expect(readAttemptEventsSince.mock.calls).toEqual([
      ["r1", "0", 500],
      ["r1", "500", 500],
    ]);
  });

  it("yields no page for a run with no frames (negative)", async () => {
    tachoChain([]);
    expect(await pagesOf(WRAPPED)).toEqual([]);
  });
});

// ADR-182: the summary job folds the frames the Run page folds. The
// composition is `readTranscriptFrames` in @oxagen/run-ledger, tested there;
// these check that the job's reads reach it.
describe("readTranscriptFramesOf", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
  const childRow = (seq: number): TachoFrameRow =>
    ({
      ...tachoRow(seq),
      sessionUuid: CHILD,
      rootSessionUuid: SESSION,
      parentSessionUuid: SESSION,
    }) as TachoFrameRow;

  it("reads a wrapped run's subagent chains, as Postgres lists them, and splices them in", async () => {
    tachoChain([0, 1]);
    mocks.withTenantDb.mockResolvedValue([{ sessionUuid: CHILD }]);
    mocks.selectTachoSubagentEvents.mockResolvedValue([childRow(0)]);
    const read = await readTranscriptFramesOf(SCOPE, WRAPPED);
    expect(read.complete).toBe(true);
    expect(
      read.frames.map((f) => [f.chain?.sessionUuid ?? "root", f.seq]),
    ).toEqual([
      ["root", "0"],
      ["root", "1"],
      // Every frame here has one timestamp and no spawn was recorded, so
      // no root frame was observed after the chain began: it goes last.
      [CHILD, "0"],
    ]);
    expect(mocks.selectTachoSubagentEvents).toHaveBeenCalledWith({
      rootSessionUuid: SESSION,
      sessionUuids: [CHILD],
      after: null,
      limit: 10_001,
    });
    expect(scopes).toEqual([SCOPE]);
  });

  it("reads no subagent frames when Postgres lists no chains (negative)", async () => {
    tachoChain([0]);
    mocks.withTenantDb.mockResolvedValue([]);
    const read = await readTranscriptFramesOf(SCOPE, WRAPPED);
    expect(read.frames.map((f) => f.seq)).toEqual(["0"]);
    expect(mocks.selectTachoSubagentEvents).not.toHaveBeenCalled();
  });

  it("stops a long chain one page past the cap and says the read was cut (negative)", async () => {
    tachoChain(range(0, 12_000));
    mocks.withTenantDb.mockResolvedValue([]);
    const read = await readTranscriptFramesOf(SCOPE, WRAPPED);
    expect(read.frames).toHaveLength(10_000);
    expect(read.complete).toBe(false);
    // 21 windows of 500 hold 10,500 rows: past the cap, so no more are read.
    expect(mocks.selectTachoEvents).toHaveBeenCalledTimes(21);
  });

  it("reads a ledger run's events and no subagent chains", async () => {
    const readAttemptEventsSince = vi.fn(() => Promise.resolve([]));
    mocks.createPostgresRunStore.mockReturnValue({ readAttemptEventsSince });
    const read = await readTranscriptFramesOf(SCOPE, {
      source: "ledger",
      runId: "r1",
      attempts: [],
    });
    expect(read).toEqual({ frames: [], complete: true });
    expect(readAttemptEventsSince).toHaveBeenCalledWith("r1", "0", 500);
    expect(mocks.selectTachoSubagentEvents).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
