/**
 * run-record: the tenant read path the export and summarize jobs share.
 * Every read runs inside the run's tenant scope; the wrapped-session select
 * fences on the public id, the org and the workspace; an unsegmented ledger
 * seal refuses to export.
 */
import { schema } from "@oxagen/database";
import {
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
vi.mock("@oxagen/telemetry", () => ({
  selectTachoEvents: mocks.selectTachoEvents,
  selectTachoEventRecords: mocks.selectTachoEventRecords,
}));

import {
  readRunFrames,
  readSealedSegments,
  resolveRunRecord,
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
