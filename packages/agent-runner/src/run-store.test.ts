/**
 * Unit coverage for run-store.ts (agent-engine v2 Phase 2b). No live database:
 * pure SQL builders + row mappers are asserted directly; the RunStore methods
 * are exercised with a fake `tx.execute` injected through
 * @oxagen/database's `makeWithTenantDbMock`/`makeWithSystemDbMock` test
 * doubles (real exports, not vi.mock'd) via a mocked `@oxagen/database`
 * module — the house style used by
 * packages/inngest-functions/src/lib/provision-webhook.test.ts. Captured SQL
 * is compiled to `{ sql, params }` with the real PgDialect, exactly like that
 * suite, so assertions are robust to drizzle internals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
});

import { makeWithTenantDbMock, makeWithSystemDbMock } from "@oxagen/database";
import {
  MAX_RUN_ATTEMPTS,
  RUN_LEASE_SECONDS,
  DEFAULT_READ_EVENTS_LIMIT,
  generateRunPublicId,
  mapClaimedRunRow,
  mapRunEventRow,
  mapRunSummaryRow,
  buildEnqueueRunSql,
  buildClaimNextRunSql,
  buildRenewLeaseSql,
  buildAppendEventsSql,
  buildReadEventsSinceSql,
  buildSaveCheckpointSql,
  buildCompleteRunSql,
  buildFailRunSql,
  buildCancelRunSql,
  buildRequestCancelSql,
  buildIsCancelRequestedSql,
  buildGetRunByPublicIdSql,
  createPostgresRunStore,
  type EnqueueRunInput,
  // ── V2 — fenced immutable attempts ─────────────────────────────────────────
  EVENT_SEQUENCE_CONFLICT_EVENT,
  generateLeaseToken,
  generateAttemptPublicId,
  buildRunRowIdentityFromSpec,
  mapRunV2IdentityRow,
  mapClaimedRunV2,
  mapAttemptEventReadRow,
  prepareAttemptEvent,
  planAttemptBatch,
  reconcileReplayedEvents,
  foldAttemptStreamDigest,
  leaseRejectionReason,
  assertLeaseUsable,
  runStatusForTerminal,
  buildEnqueueRunV2Sql,
  buildLockClaimableRunV2Sql,
  buildSelectRestorableCheckpointSql,
  buildInsertAttemptSql,
  buildInsertAttemptEventsSql,
  buildAllocateRunSeqSql,
  buildReadAttemptEventsSinceSql,
  buildSelectExpiredAttemptLeasesSql,
  type LockedLeaseRow,
  type PreparedAttemptEvent,
  type RunLeaseRef,
  type RunSecurityEventSink,
  type RunV2IdentityRow,
} from "./run-store";
import {
  EMPTY_EVENT_STREAM_DIGEST,
  EVENT_SCHEMA_VERSION,
  advanceEventStreamDigest,
} from "./event-payload-registry";
import {
  FINALIZATION_GRANT_CAPABILITY,
  generateFinalizationGrantPublicId,
} from "./finalization-grant";
import { parseRunSpecV2, type RunSpecV2 } from "./run-spec-v2";
import {
  ForbiddenEventPayloadFieldError,
  RunEventIntegrityError,
  RunEventPayloadTooLargeError,
  RunEventSequenceGapError,
  RunLeaseFencedError,
  RunStoreStateError,
  UnknownRunEventTypeError,
  isForbiddenEventPayloadFieldError,
  isRunEventIntegrityError,
  isRunEventPayloadTooLargeError,
  isRunEventSequenceGapError,
  isRunLeaseFencedError,
  isRunStoreStateError,
  isUnknownRunEventTypeError,
} from "./run-errors";

const dialect = new PgDialect();
function compile(query: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query);
}

/** Fake db executor: scripts sequential `tx.execute` returns, captures calls. */
function makeFakeTx(queue: unknown[][]) {
  const calls: unknown[] = [];
  let i = 0;
  const execute = vi.fn((query: unknown) => {
    calls.push(query);
    return Promise.resolve(queue[i++] ?? []);
  });
  return { tx: { execute }, calls, execute };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("generateRunPublicId", () => {
  it("mints an arun_-prefixed id", () => {
    expect(generateRunPublicId()).toMatch(/^arun_[0-9a-f]{22}$/);
  });

  it("is unique across calls", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => generateRunPublicId()),
    );
    expect(ids.size).toBe(50);
  });
});

describe("mapClaimedRunRow", () => {
  it("coerces numeric strings and defaults null checkpoint", () => {
    const mapped = mapClaimedRunRow({
      id: "run-1",
      public_id: "arun_abc",
      org_id: "org-1",
      workspace_id: "ws-1",
      surface: "chat",
      spec: { instruction: "hi" },
      attempts: "2",
      checkpoint: null,
      checkpoint_seq: "0",
    });
    expect(mapped).toEqual({
      runId: "run-1",
      publicId: "arun_abc",
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "chat",
      spec: { instruction: "hi" },
      attempts: 2,
      checkpoint: null,
      checkpointSeq: 0,
      // A legacy claim has no attempt identity and no fencing token, and says
      // so explicitly so a consumer branches on specVersion rather than
      // sniffing for undefined fields.
      specVersion: 1,
      lease: null,
      v2: null,
    });
  });

  it("passes through a non-null checkpoint", () => {
    const mapped = mapClaimedRunRow({
      id: "run-1",
      public_id: "arun_abc",
      org_id: "org-1",
      workspace_id: "ws-1",
      surface: "chat",
      spec: {},
      attempts: 1,
      checkpoint: { step: 3 },
      checkpoint_seq: 3,
    });
    expect(mapped.checkpoint).toEqual({ step: 3 });
    expect(mapped.checkpointSeq).toBe(3);
  });
});

describe("mapRunEventRow", () => {
  it("coerces seq to a number and created_at to a Date", () => {
    const mapped = mapRunEventRow({
      seq: "5",
      type: "text-delta",
      payload: { text: "hi" },
      created_at: "2026-07-18T00:00:00.000Z",
    });
    expect(mapped).toEqual({
      seq: 5,
      type: "text-delta",
      payload: { text: "hi" },
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
    });
  });

  it("passes through a Date instance unchanged", () => {
    const d = new Date("2026-07-18T00:00:00.000Z");
    const mapped = mapRunEventRow({
      seq: 1,
      type: "t",
      payload: {},
      created_at: d,
    });
    expect(mapped.createdAt).toBe(d);
  });
});

describe("mapRunSummaryRow", () => {
  it("coerces numeric strings, defaults null result/error, and maps dates", () => {
    const mapped = mapRunSummaryRow({
      id: "run-1",
      public_id: "arun_abc",
      surface: "api-chat",
      status: "completed",
      result: { text: "done" },
      error: null,
      checkpoint_seq: "4",
      attempts: "1",
      created_at: "2026-07-18T00:00:00.000Z",
      started_at: "2026-07-18T00:00:01.000Z",
      completed_at: "2026-07-18T00:00:02.000Z",
    });
    expect(mapped).toEqual({
      runId: "run-1",
      publicId: "arun_abc",
      surface: "api-chat",
      status: "completed",
      result: { text: "done" },
      error: null,
      checkpointSeq: 4,
      attempts: 1,
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
      startedAt: new Date("2026-07-18T00:00:01.000Z"),
      completedAt: new Date("2026-07-18T00:00:02.000Z"),
    });
  });

  it("maps a pending run's null startedAt/completedAt/result", () => {
    const mapped = mapRunSummaryRow({
      id: "run-2",
      public_id: "arun_def",
      surface: "api-chat",
      status: "pending",
      result: null,
      error: null,
      checkpoint_seq: 0,
      attempts: 0,
      created_at: new Date("2026-07-18T00:00:00.000Z"),
      started_at: null,
      completed_at: null,
    });
    expect(mapped.status).toBe("pending");
    expect(mapped.startedAt).toBeNull();
    expect(mapped.completedAt).toBeNull();
    expect(mapped.result).toBeNull();
  });

  it("passes through an error string for a failed run", () => {
    const mapped = mapRunSummaryRow({
      id: "run-3",
      public_id: "arun_ghi",
      surface: "api-chat",
      status: "failed",
      result: null,
      error: "boom",
      checkpoint_seq: 2,
      attempts: 3,
      created_at: new Date("2026-07-18T00:00:00.000Z"),
      started_at: new Date("2026-07-18T00:00:01.000Z"),
      completed_at: new Date("2026-07-18T00:00:02.000Z"),
    });
    expect(mapped.error).toBe("boom");
    expect(mapped.status).toBe("failed");
  });
});

// ── Pure SQL builders ────────────────────────────────────────────────────────

describe("buildEnqueueRunSql", () => {
  it("inserts pending status with the given org/workspace/surface/spec", () => {
    const input: EnqueueRunInput = {
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "chat",
      spec: { instruction: "hi" },
    };
    const { sql: text, params } = compile(
      buildEnqueueRunSql("arun_xyz", input),
    );
    expect(text).toContain("INSERT INTO agent.agent_runs");
    expect(text).toContain("'pending'"); // literal in the template, not a bound param
    expect(text).toContain("RETURNING id, public_id");
    expect(params).toContain("arun_xyz");
    expect(params).toContain("org-1");
    expect(params).toContain("ws-1");
    expect(params).toContain("chat");
    expect(params).toContain(JSON.stringify({ instruction: "hi" }));
  });
});

describe("buildClaimNextRunSql", () => {
  it("guards on attempts < MAX_RUN_ATTEMPTS and pending-or-expired status", () => {
    const { sql: text, params } = compile(buildClaimNextRunSql("worker-1"));
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain(
      "status = 'pending' OR (status = 'running' AND lease_expires_at < now())",
    );
    expect(text).toContain("attempts + 1");
    expect(params).toContain("worker-1");
    expect(params).toContain(MAX_RUN_ATTEMPTS);
    expect(params).toContain(RUN_LEASE_SECONDS);
  });

  it("honors an explicit attempt cap and lease window", () => {
    const { params } = compile(buildClaimNextRunSql("worker-1", 7, 42));
    expect(params).toContain(7);
    expect(params).toContain(42);
  });
});

describe("buildRenewLeaseSql / buildSaveCheckpointSql / buildCompleteRunSql / buildFailRunSql / buildCancelRunSql", () => {
  it("all guard on claimed_by + status = 'running'", () => {
    const builders: SQL[] = [
      buildRenewLeaseSql("run-1", "worker-1"),
      buildSaveCheckpointSql("run-1", "worker-1", 2, { step: 2 }),
      buildCompleteRunSql("run-1", "worker-1", { ok: true }),
      buildFailRunSql("run-1", "worker-1", "boom"),
      buildCancelRunSql("run-1", "worker-1"),
    ];
    for (const b of builders) {
      const { text, params } = ((): { text: string; params: unknown[] } => {
        const { sql: t, params: p } = compile(b);
        return { text: t, params: p };
      })();
      expect(text).toContain("claimed_by = ");
      expect(text).toContain("status = 'running'");
      expect(text).toContain("RETURNING id");
      expect(params).toContain("run-1");
      expect(params).toContain("worker-1");
    }
  });

  it("completeRun writes result + clears the lease", () => {
    const { sql: text, params } = compile(
      buildCompleteRunSql("run-1", "worker-1", { text: "done" }),
    );
    expect(text).toContain("status = 'completed'");
    expect(text).toContain("lease_expires_at = NULL");
    expect(JSON.stringify(params)).toContain("done");
  });

  it("failRun writes the error + clears the lease", () => {
    const { sql: text, params } = compile(
      buildFailRunSql("run-1", "worker-1", "boom"),
    );
    expect(text).toContain("status = 'failed'");
    expect(text).toContain("lease_expires_at = NULL");
    expect(params).toContain("boom");
  });

  it("cancelRun sets status = 'cancelled' and clears the lease", () => {
    const { sql: text } = compile(buildCancelRunSql("run-1", "worker-1"));
    expect(text).toContain("status = 'cancelled'");
    expect(text).toContain("lease_expires_at = NULL");
  });
});

describe("buildAppendEventsSql", () => {
  it("returns null for an empty batch", () => {
    expect(buildAppendEventsSql("run-1", "org-1", "ws-1", [])).toBeNull();
  });

  it("builds a multi-row VALUES insert with ON CONFLICT DO NOTHING", () => {
    const query = buildAppendEventsSql("run-1", "org-1", "ws-1", [
      { seq: 1, type: "text-delta", payload: { text: "a" } },
      { seq: 2, type: "text-delta", payload: { text: "b" } },
    ]);
    expect(query).not.toBeNull();
    const { sql: text, params } = compile(query!);
    expect(text).toContain("INSERT INTO agent.agent_run_events");
    expect(text).toContain("ON CONFLICT (run_id, seq) DO NOTHING");
    expect(params).toContain("run-1");
    expect(params).toContain(1);
    expect(params).toContain(2);
    expect(params).toContain(JSON.stringify({ text: "a" }));
    expect(params).toContain(JSON.stringify({ text: "b" }));
  });
});

describe("buildReadEventsSinceSql", () => {
  it("orders by seq ascending and filters seq > afterSeq", () => {
    const { sql: text, params } = compile(buildReadEventsSinceSql("run-1", 3));
    expect(text).toContain("ORDER BY seq ASC");
    expect(text).toContain("seq >");
    expect(params).toContain("run-1");
    expect(params).toContain(3);
    expect(params).toContain(DEFAULT_READ_EVENTS_LIMIT);
  });

  it("honors an explicit limit", () => {
    const { params } = compile(buildReadEventsSinceSql("run-1", 0, 10));
    expect(params).toContain(10);
  });
});

describe("buildRequestCancelSql / buildIsCancelRequestedSql", () => {
  it("requestCancel sets cancel_requested = true unconditionally on the row", () => {
    const { sql: text, params } = compile(buildRequestCancelSql("run-1"));
    expect(text).toContain("cancel_requested = true");
    expect(params).toContain("run-1");
  });

  it("isCancelRequested reads cancel_requested by id", () => {
    const { sql: text, params } = compile(buildIsCancelRequestedSql("run-1"));
    expect(text).toContain("SELECT cancel_requested");
    expect(params).toContain("run-1");
  });
});

describe("buildGetRunByPublicIdSql", () => {
  it("selects the RunSummary columns filtered by public_id (no org/workspace filter — RLS-scoped)", () => {
    const { sql: text, params } = compile(buildGetRunByPublicIdSql("arun_abc"));
    expect(text).toContain("SELECT id, public_id, surface, status, result");
    expect(text).toContain("checkpoint_seq");
    expect(text).toContain("attempts");
    expect(text).toContain("created_at");
    expect(text).toContain("started_at");
    expect(text).toContain("completed_at");
    expect(text).toContain("WHERE public_id =");
    expect(text).not.toContain("org_id");
    expect(text).not.toContain("workspace_id");
    expect(params).toContain("arun_abc");
  });
});

// ── RunStore methods (fake db executor, no live DB) ─────────────────────────

describe("createPostgresRunStore", () => {
  it("enqueueRun uses withTenantDb and returns the inserted id/publicId", async () => {
    const { tx, execute } = makeFakeTx([
      [{ id: "run-uuid-1", public_id: "arun_abc" }],
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.enqueueRun({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "chat",
      spec: { instruction: "hi" },
    });

    expect(result).toEqual({ runId: "run-uuid-1", publicId: "arun_abc" });
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enqueueRun throws if the insert unexpectedly returns no row", async () => {
    const { tx } = makeFakeTx([[]]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.enqueueRun({
        orgId: "o",
        workspaceId: "w",
        surface: "chat",
        spec: {},
      }),
    ).rejects.toThrow(/enqueueRun/);
  });

  it("claimNextRun uses withSystemDb and maps the returned row", async () => {
    const { tx } = makeFakeTx([
      [
        {
          id: "run-1",
          public_id: "arun_abc",
          org_id: "org-1",
          workspace_id: "ws-1",
          surface: "chat",
          spec: { instruction: "hi" },
          attempts: 1,
          checkpoint: null,
          checkpoint_seq: 0,
        },
      ],
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const claimed = await store.claimNextRun("worker-1");

    expect(claimed).toEqual({
      runId: "run-1",
      publicId: "arun_abc",
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "chat",
      spec: { instruction: "hi" },
      attempts: 1,
      checkpoint: null,
      checkpointSeq: 0,
      specVersion: 1,
      lease: null,
      v2: null,
    });
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("claimNextRun returns null when nothing is claimable", async () => {
    const { tx } = makeFakeTx([[]]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.claimNextRun("worker-1")).toBeNull();
  });

  it("renewLease returns true when a row was updated", async () => {
    const { tx } = makeFakeTx([[{ id: "run-1" }]]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.renewLease("run-1", "worker-1")).toBe(true);
  });

  it("renewLease returns false when claimed_by no longer matches (lease lost)", async () => {
    const { tx } = makeFakeTx([[]]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.renewLease("run-1", "worker-stale")).toBe(false);
  });

  it("appendEvents skips the DB round-trip for an empty batch", async () => {
    const { tx, execute } = makeFakeTx([]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await store.appendEvents("run-1", "org-1", "ws-1", []);
    expect(execute).not.toHaveBeenCalled();
  });

  it("appendEvents inserts a batch via withSystemDb (ON CONFLICT DO NOTHING)", async () => {
    const { tx, execute } = makeFakeTx([[]]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await store.appendEvents("run-1", "org-1", "ws-1", [
      { seq: 1, type: "text-delta", payload: { text: "a" } },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql: text } = compile(execute.mock.calls[0]![0] as SQL);
    expect(text).toContain("ON CONFLICT (run_id, seq) DO NOTHING");
  });

  it("readEventsSince uses withTenantDb and maps rows in order", async () => {
    const { tx } = makeFakeTx([
      [
        {
          seq: 1,
          type: "text-delta",
          payload: { text: "a" },
          created_at: "2026-07-18T00:00:00.000Z",
        },
        {
          seq: 2,
          type: "final-diff",
          payload: { diff: "x" },
          created_at: "2026-07-18T00:00:01.000Z",
        },
      ],
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    const events = await store.readEventsSince("run-1", 0);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      seq: 1,
      type: "text-delta",
      payload: { text: "a" },
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("saveCheckpoint / completeRun / failRun / cancelRun all use withSystemDb and report the guard result", async () => {
    const store = createPostgresRunStore();

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[{ id: "run-1" }]]).tx),
    );
    expect(
      await store.saveCheckpoint("run-1", "worker-1", 1, { step: 1 }),
    ).toBe(true);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[]]).tx),
    );
    expect(
      await store.saveCheckpoint("run-1", "worker-stale", 1, { step: 1 }),
    ).toBe(false);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[{ id: "run-1" }]]).tx),
    );
    expect(await store.completeRun("run-1", "worker-1", { text: "done" })).toBe(
      true,
    );

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[]]).tx),
    );
    expect(
      await store.completeRun("run-1", "worker-stale", { text: "done" }),
    ).toBe(false);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[{ id: "run-1" }]]).tx),
    );
    expect(await store.failRun("run-1", "worker-1", "boom")).toBe(true);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[]]).tx),
    );
    expect(await store.failRun("run-1", "worker-stale", "boom")).toBe(false);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[{ id: "run-1" }]]).tx),
    );
    expect(await store.cancelRun("run-1", "worker-1")).toBe(true);

    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeFakeTx([[]]).tx),
    );
    expect(await store.cancelRun("run-1", "worker-stale")).toBe(false);
  });

  it("requestCancel writes via withTenantDb", async () => {
    const { tx, execute } = makeFakeTx([[]]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    await store.requestCancel("run-1");
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql: text } = compile(execute.mock.calls[0]![0] as SQL);
    expect(text).toContain("cancel_requested = true");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("isCancelRequested reads the flag via withTenantDb", async () => {
    const { tx } = makeFakeTx([[{ cancel_requested: true }]]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.isCancelRequested("run-1")).toBe(true);
  });

  it("isCancelRequested defaults to false when the row is missing", async () => {
    const { tx } = makeFakeTx([[]]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.isCancelRequested("missing-run")).toBe(false);
  });

  it("getRunByPublicId uses withTenantDb and maps the found row", async () => {
    const { tx } = makeFakeTx([
      [
        {
          id: "run-1",
          public_id: "arun_abc",
          surface: "api-chat",
          status: "running",
          result: null,
          error: null,
          checkpoint_seq: 2,
          attempts: 1,
          created_at: "2026-07-18T00:00:00.000Z",
          started_at: "2026-07-18T00:00:01.000Z",
          completed_at: null,
        },
      ],
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    const summary = await store.getRunByPublicId("arun_abc");
    expect(summary).toEqual({
      runId: "run-1",
      publicId: "arun_abc",
      surface: "api-chat",
      status: "running",
      result: null,
      error: null,
      checkpointSeq: 2,
      attempts: 1,
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
      startedAt: new Date("2026-07-18T00:00:01.000Z"),
      completedAt: null,
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("getRunByPublicId returns null for an unknown or cross-tenant publicId", async () => {
    const { tx } = makeFakeTx([[]]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.getRunByPublicId("arun_missing")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 — fenced immutable attempts
// ═══════════════════════════════════════════════════════════════════════════

const UUID_ORG = "11111111-1111-4111-8111-111111111111";
const UUID_WS = "22222222-2222-4222-8222-222222222222";
const UUID_RUN = "33333333-3333-4333-8333-333333333333";
const UUID_ATTEMPT = "44444444-4444-4444-8444-444444444444";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UUID_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const UUID_F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SHA_1 = `sha256:${"1".repeat(64)}`;
const SHA_2 = `sha256:${"2".repeat(64)}`;
const SHA_3 = `sha256:${"3".repeat(64)}`;
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const ATTEMPT_PUBLIC_ID = "arat_0123456789abcdef0123";
const BLOB_REF = "evb_0123456789abcdef0123";
const DECISION_REF = "azd_0123456789abcdef0123";
const OBSERVED_AT = "2026-07-21T12:00:00.000Z";

const ENGINE = {
  name: "ts",
  version: "2.1.1",
  buildDigest: SHA_1,
} as const;

function makeSpec(overrides: Record<string, unknown> = {}): RunSpecV2 {
  return parseRunSpecV2({
    version: 2,
    run_kind: "repo_edit",
    goal: "add a health check route",
    engine_policy: {
      requested_engine: "ts",
      allowed_engine_versions: ["2.1.1"],
      model_policy_ref: "default",
      max_steps: 64,
      max_attempts: 3,
    },
    actor_binding: {
      initiating_principal_id: UUID_A,
      agent_principal_id: UUID_B,
      agent_id: UUID_C,
      agent_version_id: UUID_D,
      agent_version_checksum: SHA_1,
    },
    authorization_snapshot_ref: {
      snapshot_id: UUID_E,
      snapshot_digest: SHA_2,
      grant_ceiling_digest: SHA_3,
      deny_generation_at_admission: { org: "7", workspace: "3" },
      resolved_at: OBSERVED_AT,
    },
    repository_binding: {
      repository_binding_public_id: "rpb_0123456789abcdef0123",
      provider: "github",
      provider_repository_id: "987654",
      connection_id: UUID_F,
      configured_default_ref: "main",
      base_commit_sha: COMMIT_SHA,
      base_tree_sha: TREE_SHA,
    },
    workspace_policy: { sandbox_required: true },
    context_policy: {
      provider_allowlist: ["knowledge_graph"],
      max_frames: 32,
      max_tokens: 100_000,
      retention_policy_id: "rpv_0123456789abcdef0123",
      retention_policy_digest: SHA_2,
    },
    tool_policy: { allowlist: ["edit_repo_file"], risk_ceiling: "high" },
    output_policy: { open_pull_request: true },
    ...overrides,
  });
}

/** The typed columns a V2 run row returns, matching `makeSpec()` exactly. */
function makeIdentityRow(
  overrides: Partial<RunV2IdentityRow> = {},
): RunV2IdentityRow {
  return {
    spec_version: 2,
    run_kind: "repo_edit",
    spec_digest: buildRunRowIdentityFromSpec(makeSpec()).spec_digest,
    initiating_principal_id: UUID_A,
    agent_principal_id: UUID_B,
    agent_id: UUID_C,
    agent_version_id: UUID_D,
    agent_version_checksum: SHA_1,
    authorization_snapshot_id: UUID_E,
    parent_run_id: null,
    repository_binding_id: "55555555-5555-4555-8555-555555555555",
    repository_binding_public_id: "rpb_0123456789abcdef0123",
    repository_provider: "github",
    provider_repository_id: "987654",
    repository_connection_id: UUID_F,
    configured_default_ref: "main",
    base_commit_sha: COMMIT_SHA,
    base_tree_sha: TREE_SHA,
    retention_policy_id: "66666666-6666-4666-8666-666666666666",
    retention_policy_public_id: "rpv_0123456789abcdef0123",
    retention_policy_digest: SHA_2,
    max_attempts: 3,
    ...overrides,
  };
}

const LEASE: RunLeaseRef = {
  runId: UUID_RUN,
  attemptId: UUID_ATTEMPT,
  attemptPublicId: ATTEMPT_PUBLIC_ID,
  leaseToken: "token-1",
  leaseEpoch: 4,
};

function makeLeaseRow(overrides: Partial<LockedLeaseRow> = {}): LockedLeaseRow {
  return {
    id: "lease-1",
    attempt_id: UUID_ATTEMPT,
    attempt_public_id: ATTEMPT_PUBLIC_ID,
    run_id: UUID_RUN,
    org_id: UUID_ORG,
    workspace_id: UUID_WS,
    lease_token: "token-1",
    lease_epoch: 4,
    worker_id: "worker-1",
    expired: false,
    fenced_at: null,
    last_run_seq: null,
    last_attempt_seq: null,
    event_count: 0,
    final_event_digest: null,
    event_stream_digest: EMPTY_EVENT_STREAM_DIGEST,
    seal_id: null,
    ...overrides,
  };
}

function toolEvent(attemptSeq: number, callId = "call_1") {
  return {
    attemptSeq,
    eventType: "tool.call_completed",
    observedAt: OBSERVED_AT,
    payload: {
      tool_call_id: callId,
      capability_name: "edit_repo_file",
      outcome: "completed" as const,
      input_digest: SHA_1,
      authorization_decision_ref: DECISION_REF,
      duration_ms: 5,
    },
  };
}

function terminalEvent(attemptSeq: number) {
  return {
    attemptSeq,
    eventType: "terminal.attempt_terminated",
    observedAt: OBSERVED_AT,
    payload: { terminal_status: "completed" as const },
  };
}

/**
 * A fake `tx.execute` that routes on the COMPILED SQL text rather than call
 * order. Statement order inside one transaction is an implementation detail;
 * routing keeps these tests asserting behavior instead of a call sequence.
 */
type Route = { match: RegExp; rows: unknown[] | (() => unknown[]) };

function makeRoutingTx(routes: Route[]) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn((query: unknown) => {
    const compiled = compile(query as SQL);
    executed.push(compiled);
    for (const route of routes) {
      if (route.match.test(compiled.sql)) {
        const rows =
          typeof route.rows === "function" ? route.rows() : route.rows;
        return Promise.resolve(rows);
      }
    }
    return Promise.resolve([]);
  });
  return { tx: { execute }, executed, execute };
}

function ranSql(
  executed: Array<{ sql: string; params: unknown[] }>,
  pattern: RegExp,
): boolean {
  return executed.some((e) => pattern.test(e.sql));
}

// Both locks take their row in a CTE and project afterwards, so the routes key
// on what is unique to each statement rather than on the locking clause.
const LOCK_RUN = /spec_version = 2/;
const LOCK_LEASE = /JOIN agent\.agent_run_attempts a ON a\.id = l\.attempt_id/;
const SELECT_CHECKPOINT = /FROM agent\.agent_run_checkpoints c/;
const INSERT_ATTEMPT = /INSERT INTO agent\.agent_run_attempts/;
const SELECT_EPOCH = /COALESCE\(MAX\(lease_epoch\), 0\) \+ 1/;
const INSERT_LEASE = /INSERT INTO agent\.agent_run_attempt_leases/;
// Distinguishes the V2 claim from the V1 one, which also sets status =
// 'running' but never touches attempt_count.
const MARK_CLAIMED = /attempt_count = attempt_count \+ 1/;
const LEGACY_CLAIM = /FOR UPDATE SKIP LOCKED/;
const ALLOCATE_RUN_SEQ = /next_run_seq = next_run_seq \+/;
const INSERT_EVENTS = /INSERT INTO agent\.agent_run_events/;
const SELECT_EXISTING_EVENTS = /SELECT id, attempt_seq, run_seq, event_digest/;
const INSERT_CHECKPOINT = /INSERT INTO agent\.agent_run_checkpoints/;
const SET_LATEST_CHECKPOINT = /latest_checkpoint_id = /;
const ADVANCE_LEASE = /SET\s+last_run_seq/;
const RENEW_LEASE = /SET\s+expires_at = now\(\)/;
const FENCE_LEASE = /SET\s+fenced_at = now\(\)/;
const INSERT_SEAL = /INSERT INTO agent\.agent_run_attempt_seals/;
const INSERT_GRANT = /INSERT INTO agent\.agent_run_finalization_grants/;
const INSERT_OBLIGATION =
  /INSERT INTO agent\.agent_run_finalization_obligations/;
const SELECT_HANDLE = /JOIN agent\.agent_run_finalization_grants g/;
const FINISH_RUN = /active_attempt_id = NULL,\s+claimed_by = NULL/;
const REQUEUE_RUN = /status = 'pending'/;
const SELECT_EXPIRED = /ORDER BY l\.expires_at ASC/;
const CANCEL_CHECK = /SELECT r\.cancel_requested/;

// ── Public id + token generation ────────────────────────────────────────────

describe("V2 id generation", () => {
  it("mints arat_, afg_, and opaque lease tokens", () => {
    expect(generateAttemptPublicId()).toMatch(/^arat_[0-9a-f]{22}$/);
    expect(generateFinalizationGrantPublicId()).toMatch(/^afg_[0-9a-f]{22}$/);
    expect(generateLeaseToken()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a lease token that is not derived from any attempt id", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateLeaseToken));
    expect(tokens.size).toBe(50);
    expect(tokens.has(UUID_ATTEMPT)).toBe(false);
  });
});

// ── Row/spec identity ───────────────────────────────────────────────────────

describe("buildRunRowIdentityFromSpec / mapRunV2IdentityRow", () => {
  it("projects a repo_edit spec into every typed column", () => {
    const identity = buildRunRowIdentityFromSpec(makeSpec());
    expect(identity.spec_version).toBe(2);
    expect(identity.run_kind).toBe("repo_edit");
    expect(identity.spec_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(identity.repository_binding_public_id).toBe(
      "rpb_0123456789abcdef0123",
    );
    expect(identity.base_commit_sha).toBe(COMMIT_SHA);
    expect(identity.max_attempts).toBe(3);
  });

  it("nulls every repository column for a general run", () => {
    const raw = JSON.parse(JSON.stringify(makeSpec())) as Record<
      string,
      unknown
    >;
    // A general spec is `.strict()`, so the repository sections must be ABSENT,
    // not present-and-undefined — that is what stops a general run acquiring
    // repository authority without being labelled repo_edit.
    delete raw.repository_binding;
    delete raw.output_policy;
    const general = parseRunSpecV2({ ...raw, run_kind: "general" });
    const identity = buildRunRowIdentityFromSpec(general);
    expect(identity.repository_binding_public_id).toBeNull();
    expect(identity.provider).toBeNull();
    expect(identity.base_commit_sha).toBeNull();
  });

  it("round-trips a stored row back to the same identity as the spec", () => {
    const fromSpec = buildRunRowIdentityFromSpec(makeSpec());
    const fromRow = mapRunV2IdentityRow(makeIdentityRow());
    expect(fromRow).toEqual(fromSpec);
  });

  it("takes the public ids from the JOINED rows, not from the run's uuids", () => {
    // The uuid columns and the public ids are DIFFERENT values; the projection
    // must read the joined public id, which is what proves the resolved uuid
    // really addresses the binding the spec pinned.
    const mapped = mapRunV2IdentityRow(makeIdentityRow());
    expect(mapped.retention_policy_id).toBe("rpv_0123456789abcdef0123");
    expect(mapped.repository_binding_public_id).toBe(
      "rpb_0123456789abcdef0123",
    );
  });

  it("reports an unjoined binding as an empty/null public id so comparison fails", () => {
    const mapped = mapRunV2IdentityRow(
      makeIdentityRow({ retention_policy_public_id: null }),
    );
    expect(mapped.retention_policy_id).toBe("");
  });
});

// ── Event preparation ───────────────────────────────────────────────────────

describe("prepareAttemptEvent", () => {
  it("validates an inline payload and computes both digests", () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    expect(prepared.stage).toBe("tool");
    expect(prepared.eventSchemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(prepared.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.encryptedPayloadRef).toBeNull();
  });

  it("accepts an encrypted reference plus a producer-supplied payload digest", () => {
    const prepared = prepareAttemptEvent({
      attemptSeq: 1,
      eventType: "context.frames_selected",
      observedAt: OBSERVED_AT,
      encryptedPayloadRef: BLOB_REF,
      payloadDigest: SHA_1,
    });
    expect(prepared.payload).toBeNull();
    expect(prepared.encryptedPayloadRef).toBe(BLOB_REF);
    expect(prepared.payloadDigest).toBe(SHA_1);
  });

  it("refuses an event carrying BOTH an inline payload and an encrypted ref", () => {
    expect(() =>
      prepareAttemptEvent({
        ...toolEvent(1),
        encryptedPayloadRef: BLOB_REF,
        payloadDigest: SHA_1,
      }),
    ).toThrow(RunStoreStateError);
  });

  it("refuses an event carrying NEITHER", () => {
    expect(() =>
      prepareAttemptEvent({
        attemptSeq: 1,
        eventType: "tool.call_completed",
        observedAt: OBSERVED_AT,
      }),
    ).toThrow(RunStoreStateError);
  });

  it("gives the same digest for a replayed event with the same observed time", () => {
    expect(prepareAttemptEvent(toolEvent(1)).eventDigest).toBe(
      prepareAttemptEvent(toolEvent(1)).eventDigest,
    );
  });

  it("gives a DIFFERENT digest when the producer re-stamps observed_at", () => {
    // Documented footgun: a replay must resend the ORIGINAL observation time.
    const restamped = {
      ...toolEvent(1),
      observedAt: "2026-07-21T12:00:01.000Z",
    };
    expect(prepareAttemptEvent(restamped).eventDigest).not.toBe(
      prepareAttemptEvent(toolEvent(1)).eventDigest,
    );
  });
});

// ── Batch planning ──────────────────────────────────────────────────────────

describe("planAttemptBatch", () => {
  const prep = (seq: number) => prepareAttemptEvent(toolEvent(seq));

  it("returns an empty plan for an empty batch", () => {
    expect(planAttemptBatch(UUID_ATTEMPT, 0, [])).toEqual({
      replays: [],
      appends: [],
    });
  });

  it("classifies a fresh contiguous batch as all appends", () => {
    const plan = planAttemptBatch(UUID_ATTEMPT, 0, [prep(1), prep(2), prep(3)]);
    expect(plan.replays).toHaveLength(0);
    expect(plan.appends.map((e) => e.attemptSeq)).toEqual([1, 2, 3]);
  });

  it("splits a crash retry into the durable prefix and the new suffix", () => {
    const plan = planAttemptBatch(UUID_ATTEMPT, 2, [
      prep(1),
      prep(2),
      prep(3),
      prep(4),
    ]);
    expect(plan.replays.map((e) => e.attemptSeq)).toEqual([1, 2]);
    expect(plan.appends.map((e) => e.attemptSeq)).toEqual([3, 4]);
  });

  it("classifies a fully-replayed batch as all replays", () => {
    const plan = planAttemptBatch(UUID_ATTEMPT, 5, [prep(1), prep(2)]);
    expect(plan.appends).toHaveLength(0);
    expect(plan.replays).toHaveLength(2);
  });

  it("refuses a hole inside the batch", () => {
    expect(() => planAttemptBatch(UUID_ATTEMPT, 0, [prep(1), prep(3)])).toThrow(
      RunEventSequenceGapError,
    );
  });

  it("refuses a batch that skips ahead of the lease pointer", () => {
    let caught: unknown;
    try {
      planAttemptBatch(UUID_ATTEMPT, 4, [prep(6)]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunEventSequenceGapError);
    expect((caught as RunEventSequenceGapError).expectedSeq).toBe(5);
    expect((caught as RunEventSequenceGapError).receivedSeq).toBe(6);
  });

  it("refuses a non-positive sequence", () => {
    const zero = { ...prep(1), attemptSeq: 0 } as PreparedAttemptEvent;
    expect(() => planAttemptBatch(UUID_ATTEMPT, 0, [zero])).toThrow(
      RunEventSequenceGapError,
    );
  });
});

// ── Replay reconciliation — the integrity gate ──────────────────────────────

describe("reconcileReplayedEvents", () => {
  const prepared = prepareAttemptEvent(toolEvent(1));

  it("returns the prior row and run sequence for an identical digest", () => {
    const result = reconcileReplayedEvents(
      UUID_ATTEMPT,
      [prepared],
      [
        {
          id: "event-1",
          attempt_seq: 1,
          run_seq: "17",
          event_digest: prepared.eventDigest,
        },
      ],
    );
    expect(result).toEqual([
      {
        attemptSeq: 1,
        runSeq: "17",
        eventId: "event-1",
        eventDigest: prepared.eventDigest,
        idempotent: true,
      },
    ]);
  });

  it("throws RunEventIntegrityError for the same sequence with a different digest", () => {
    let caught: unknown;
    try {
      reconcileReplayedEvents(
        UUID_ATTEMPT,
        [prepared],
        [
          {
            id: "event-1",
            attempt_seq: 1,
            run_seq: 17,
            event_digest: SHA_3,
          },
        ],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunEventIntegrityError);
    expect((caught as RunEventIntegrityError).storedDigest).toBe(SHA_3);
    expect((caught as RunEventIntegrityError).incomingDigest).toBe(
      prepared.eventDigest,
    );
    expect((caught as RunEventIntegrityError).attemptSeq).toBe(1);
  });

  it("throws when the lease pointer claims a sequence the log does not hold", () => {
    expect(() => reconcileReplayedEvents(UUID_ATTEMPT, [prepared], [])).toThrow(
      RunStoreStateError,
    );
  });
});

// ── Stream digest fold ──────────────────────────────────────────────────────

describe("foldAttemptStreamDigest", () => {
  it("folds only the NEW events, matching an event-by-event advance", () => {
    const a = prepareAttemptEvent(toolEvent(1, "call_a"));
    const b = prepareAttemptEvent(toolEvent(2, "call_b"));
    const expected = advanceEventStreamDigest(
      advanceEventStreamDigest(EMPTY_EVENT_STREAM_DIGEST, a),
      b,
    );
    expect(foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, [a, b])).toBe(
      expected,
    );
  });

  it("is a no-op for an empty append list — a pure replay never moves it", () => {
    expect(foldAttemptStreamDigest(SHA_2, [])).toBe(SHA_2);
  });
});

// ── Lease validation ────────────────────────────────────────────────────────

describe("leaseRejectionReason", () => {
  it("permits a live, matching, unsealed lease", () => {
    expect(leaseRejectionReason(makeLeaseRow(), LEASE)).toBeNull();
  });

  it("refuses an unknown lease", () => {
    expect(leaseRejectionReason(undefined, LEASE)).toBe("unknown_lease");
  });

  it("refuses a mismatched token — a leaked attempt id must not grant writes", () => {
    expect(
      leaseRejectionReason(makeLeaseRow({ lease_token: "other" }), LEASE),
    ).toBe("token_mismatch");
  });

  it("refuses a stale epoch", () => {
    expect(leaseRejectionReason(makeLeaseRow({ lease_epoch: 3 }), LEASE)).toBe(
      "epoch_mismatch",
    );
  });

  it("reports `sealed` ahead of `fenced` so a duplicate seal is recognizable", () => {
    // A seal always fences its own lease. Testing the fence first would report
    // every duplicate seal as a generic fence and the idempotent duplicate-sweep
    // path could never recognize itself.
    expect(
      leaseRejectionReason(
        makeLeaseRow({ seal_id: "seal-1", fenced_at: "2026-07-21T12:00:00Z" }),
        LEASE,
      ),
    ).toBe("sealed");
  });

  it("reports a fence WITHOUT a seal as `fenced`", () => {
    expect(
      leaseRejectionReason(
        makeLeaseRow({ fenced_at: "2026-07-21T12:00:00Z" }),
        LEASE,
      ),
    ).toBe("fenced");
  });

  it("refuses an expired lease by default", () => {
    expect(leaseRejectionReason(makeLeaseRow({ expired: true }), LEASE)).toBe(
      "expired",
    );
  });

  it("permits an expired lease only for the reclaimer", () => {
    expect(
      leaseRejectionReason(makeLeaseRow({ expired: true }), LEASE, {
        allowExpired: true,
      }),
    ).toBeNull();
  });

  it("assertLeaseUsable throws RunLeaseFencedError carrying the reason", () => {
    let caught: unknown;
    try {
      assertLeaseUsable(makeLeaseRow({ expired: true }), LEASE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunLeaseFencedError);
    expect((caught as RunLeaseFencedError).reason).toBe("expired");
    expect((caught as RunLeaseFencedError).attemptId).toBe(UUID_ATTEMPT);
  });
});

describe("runStatusForTerminal", () => {
  it("maps every terminal status onto a run status, denied included", () => {
    expect(runStatusForTerminal("completed")).toBe("completed");
    expect(runStatusForTerminal("cancelled")).toBe("cancelled");
    expect(runStatusForTerminal("failed")).toBe("failed");
    expect(runStatusForTerminal("denied")).toBe("failed");
    expect(runStatusForTerminal("abandoned")).toBe("failed");
  });
});

// ── SQL builder shape ───────────────────────────────────────────────────────

describe("V2 SQL builders", () => {
  it("enqueueRunV2 writes spec_version 2 and joins back to both bindings", () => {
    const { sql: text, params } = compile(
      buildEnqueueRunV2Sql("arun_x", SHA_1, {
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        surface: "repo-edit",
        spec: makeSpec(),
        retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
        repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
      }),
    );
    expect(text).toContain("INSERT INTO agent.agent_runs");
    expect(text).toContain("'pending'");
    // The joins ARE the verification: they prove the resolved uuid addresses
    // the public id the spec pinned.
    expect(text).toContain(
      "LEFT JOIN ingestion.repository_bindings rb ON rb.id = i.repository_binding_id",
    );
    expect(text).toContain(
      "LEFT JOIN evidence.retention_policy_versions rpv ON rpv.id = i.retention_policy_id",
    );
    expect(params).toContain("arun_x");
    expect(params).toContain(SHA_1);
    expect(params).toContain(COMMIT_SHA);
    expect(params).toContain(3); // max_attempts
  });

  it("the V2 claim locks only PENDING rows under the pinned attempt cap", () => {
    const { sql: text } = compile(buildLockClaimableRunV2Sql());
    expect(text).toContain("spec_version = 2");
    expect(text).toContain("status = 'pending'");
    expect(text).toContain("attempt_count < max_attempts");
    // A running V2 run is never stolen by a claim — only the reclaimer may
    // fence it, because fencing means sealing and minting its grant.
    expect(text).not.toContain("lease_expires_at <");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("restores only a SEALED prior attempt's checkpoint with a parsable schema", () => {
    const { sql: text, params } = compile(
      buildSelectRestorableCheckpointSql(UUID_RUN, ["engine-state/v1"]),
    );
    expect(text).toContain(
      "JOIN agent.agent_run_attempt_seals s ON s.attempt_id = c.attempt_id",
    );
    expect(text).toContain("engine_state_schema = ANY(");
    expect(text).toContain("ORDER BY c.run_seq DESC");
    expect(params).toContain(UUID_RUN);
  });

  it("pins the resolved engine identity and the whole restore tuple on the attempt", () => {
    const { sql: text, params } = compile(
      buildInsertAttemptSql({
        publicId: ATTEMPT_PUBLIC_ID,
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        runId: UUID_RUN,
        attemptNumber: 2,
        workerId: "worker-1",
        engine: ENGINE,
        restore: {
          attemptId: UUID_A,
          attemptPublicId: "arat_prior0123456789abcd",
          checkpointId: UUID_B,
          checkpointDigest: SHA_2,
          streamDigest: SHA_3,
          engineStateSchema: "engine-state/v1",
          encryptedStateRef: BLOB_REF,
          attemptSeq: 9,
          runSeq: 14,
        },
      }),
    );
    expect(text).toContain("INSERT INTO agent.agent_run_attempts");
    expect(params).toContain("ts");
    expect(params).toContain("2.1.1");
    expect(params).toContain(SHA_1); // engine build digest
    expect(params).toContain("arat_prior0123456789abcd");
    expect(params).toContain(SHA_2); // restored checkpoint digest
  });

  it("allocates run sequences off the run row, not a SEQUENCE object", () => {
    const { sql: text } = compile(buildAllocateRunSeqSql(UUID_RUN, 3));
    // A SEQUENCE would burn numbers on a rolled-back append and leave holes an
    // auditor cannot explain.
    expect(text).toContain("next_run_seq = next_run_seq +");
    expect(text).toContain("RETURNING (next_run_seq -");
  });

  it("the V2 event insert has NO conflict clause", () => {
    const query = buildInsertAttemptEventsSql(
      UUID_RUN,
      UUID_ORG,
      UUID_WS,
      UUID_ATTEMPT,
      [{ ...prepareAttemptEvent(toolEvent(1)), runSeq: "5" }],
    );
    expect(query).not.toBeNull();
    const { sql: text } = compile(query as SQL);
    expect(text).toContain("INSERT INTO agent.agent_run_events");
    expect(text).not.toContain("ON CONFLICT");
    expect(text).toContain("event_record_version");
    expect(text).toContain("RETURNING id, attempt_seq, run_seq::text");
  });

  it("returns null for an empty V2 batch instead of an INSERT with no VALUES", () => {
    expect(
      buildInsertAttemptEventsSql(
        UUID_RUN,
        UUID_ORG,
        UUID_WS,
        UUID_ATTEMPT,
        [],
      ),
    ).toBeNull();
  });

  it("the V1 append KEEPS ON CONFLICT DO NOTHING", () => {
    // V1 rows carry no digest, so the drop hides no integrity failure, and the
    // V1 worker's crash-replay safety depends on it. Removing it here would be
    // a regression, not a hardening.
    const query = buildAppendEventsSql(UUID_RUN, UUID_ORG, UUID_WS, [
      { seq: 1, type: "text-delta", payload: {} },
    ]);
    expect(compile(query as SQL).sql).toContain(
      "ON CONFLICT (run_id, seq) DO NOTHING",
    );
  });

  it("reads V2 events by decimal run_seq and returns it as text", () => {
    const { sql: text, params } = compile(
      buildReadAttemptEventsSinceSql(UUID_RUN, "9007199254740993", 10),
    );
    expect(text).toContain("e.event_record_version = 2");
    expect(text).toContain("e.run_seq::text AS run_seq");
    expect(text).toContain("ORDER BY e.run_seq ASC");
    expect(params).toContain("9007199254740993");
    expect(params).toContain(10);
  });

  it("sweeps only expired, unfenced, unsealed leases", () => {
    const { sql: text } = compile(buildSelectExpiredAttemptLeasesSql(5));
    expect(text).toContain("l.fenced_at IS NULL");
    expect(text).toContain("l.expires_at <= now()");
    expect(text).toContain("s.id IS NULL");
    expect(text).toContain("ORDER BY l.expires_at ASC");
  });
});

describe("mapAttemptEventReadRow", () => {
  it("carries run_seq as an exact DECIMAL STRING past 2^53", () => {
    const mapped = mapAttemptEventReadRow({
      id: "event-1",
      attempt_id: UUID_ATTEMPT,
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      run_seq: "9007199254740993",
      attempt_seq: "3",
      event_schema_version: EVENT_SCHEMA_VERSION,
      event_type: "tool.call_completed",
      stage: "tool",
      payload_digest: SHA_1,
      event_digest: SHA_2,
      payload_inline: { ok: true },
      encrypted_payload_ref: null,
      observed_at: OBSERVED_AT,
      created_at: "2026-07-21T12:00:02.000Z",
    });
    // A JS number would silently become 9007199254740992 here and resume a
    // subscription at the wrong event.
    expect(mapped.runSeq).toBe("9007199254740993");
    expect(mapped.attemptSeq).toBe(3);
    expect(mapped.observedAt).toEqual(new Date(OBSERVED_AT));
    expect(mapped.recordedAt).toEqual(new Date("2026-07-21T12:00:02.000Z"));
    expect(mapped.payload).toEqual({ ok: true });
  });

  it("maps an encrypted-payload event with a null inline body", () => {
    const mapped = mapAttemptEventReadRow({
      id: "event-2",
      attempt_id: UUID_ATTEMPT,
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      run_seq: "2",
      attempt_seq: 2,
      event_schema_version: EVENT_SCHEMA_VERSION,
      event_type: "context.frames_selected",
      stage: "context",
      payload_digest: SHA_1,
      event_digest: SHA_2,
      payload_inline: null,
      encrypted_payload_ref: BLOB_REF,
      observed_at: new Date(OBSERVED_AT),
      created_at: new Date(OBSERVED_AT),
    });
    expect(mapped.payload).toBeNull();
    expect(mapped.encryptedPayloadRef).toBe(BLOB_REF);
  });
});

// ── Store methods, one transaction at a time ────────────────────────────────

describe("enqueueRunV2", () => {
  it("verifies what Postgres stored against the spec and returns the digest", async () => {
    const spec = makeSpec();
    const { tx } = makeRoutingTx([
      {
        match: /INSERT INTO agent\.agent_runs/,
        rows: [{ id: UUID_RUN, public_id: "arun_x", ...makeIdentityRow() }],
      },
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.enqueueRunV2({
      orgId: UUID_ORG,
      workspaceId: UUID_WS,
      surface: "repo-edit",
      spec,
      retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
      repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
    });

    expect(result.runId).toBe(UUID_RUN);
    expect(result.publicId).toBe("arun_x");
    expect(result.specDigest).toBe(
      buildRunRowIdentityFromSpec(spec).spec_digest,
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("fails closed when the stored row disagrees with the spec", async () => {
    const { tx } = makeRoutingTx([
      {
        match: /INSERT INTO agent\.agent_runs/,
        rows: [
          {
            id: UUID_RUN,
            public_id: "arun_x",
            // A different agent version than the spec binds.
            ...makeIdentityRow({ agent_version_id: UUID_A }),
          },
        ],
      },
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.enqueueRunV2({
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        surface: "repo-edit",
        spec: makeSpec(),
        retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
        repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/agent_version_id/);
  });

  it("fails closed when the resolved uuid addresses a DIFFERENT retention policy", async () => {
    const { tx } = makeRoutingTx([
      {
        match: /INSERT INTO agent\.agent_runs/,
        rows: [
          {
            id: UUID_RUN,
            public_id: "arun_x",
            ...makeIdentityRow({
              retention_policy_public_id: "rpv_ffffffffffffffffffff",
            }),
          },
        ],
      },
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.enqueueRunV2({
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        surface: "repo-edit",
        spec: makeSpec(),
        retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
        repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/retention_policy_id/);
  });

  it("throws when the insert returns no row", async () => {
    const { tx } = makeRoutingTx([]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.enqueueRunV2({
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        surface: "repo-edit",
        spec: makeSpec(),
        retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
        repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(RunStoreStateError);
  });
});

describe("claimNextRunV2", () => {
  function claimRoutes(
    overrides: { run?: unknown[]; checkpoint?: unknown[] } = {},
  ) {
    return [
      {
        match: LOCK_RUN,
        rows: overrides.run ?? [
          {
            id: UUID_RUN,
            public_id: "arun_x",
            org_id: UUID_ORG,
            workspace_id: UUID_WS,
            surface: "repo-edit",
            spec: makeSpec(),
            attempt_count: 0,
            next_run_seq: 1,
            latest_checkpoint_id: null,
            ...makeIdentityRow(),
          },
        ],
      },
      { match: SELECT_CHECKPOINT, rows: overrides.checkpoint ?? [] },
      {
        match: INSERT_ATTEMPT,
        rows: [
          { id: UUID_ATTEMPT, public_id: ATTEMPT_PUBLIC_ID, attempt_number: 1 },
        ],
      },
      { match: SELECT_EPOCH, rows: [{ next_epoch: "4" }] },
      {
        match: INSERT_LEASE,
        rows: [{ id: "lease-1", expires_at: OBSERVED_AT }],
      },
      { match: MARK_CLAIMED, rows: [{ id: UUID_RUN }] },
    ];
  }

  it("creates a distinct attempt with a fenced lease in ONE transaction", async () => {
    const { tx, executed } = makeRoutingTx(claimRoutes());
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const claimed = await store.claimNextRunV2("worker-1", { engine: ENGINE });

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1); // one transaction
    expect(claimed).not.toBeNull();
    expect(claimed?.specVersion).toBe(2);
    expect(claimed?.lease).toEqual({
      runId: UUID_RUN,
      attemptId: UUID_ATTEMPT,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      leaseEpoch: 4,
    });
    expect(claimed?.v2.engine).toEqual(ENGINE);
    expect(claimed?.v2.attemptNumber).toBe(1);
    expect(claimed?.v2.restore).toBeNull();
    expect(ranSql(executed, INSERT_ATTEMPT)).toBe(true);
    expect(ranSql(executed, INSERT_LEASE)).toBe(true);
    expect(ranSql(executed, MARK_CLAIMED)).toBe(true);
  });

  it("returns null when nothing is claimable, without creating an attempt", async () => {
    const { tx, executed } = makeRoutingTx(claimRoutes({ run: [] }));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(
      await store.claimNextRunV2("worker-1", { engine: ENGINE }),
    ).toBeNull();
    expect(ranSql(executed, INSERT_ATTEMPT)).toBe(false);
  });

  it("records restored checkpoint provenance without reusing the prior attempt id", async () => {
    const { tx } = makeRoutingTx(
      claimRoutes({
        checkpoint: [
          {
            id: UUID_B,
            attempt_id: UUID_A,
            attempt_public_id: "arat_prior0123456789abcd",
            attempt_seq: "9",
            run_seq: "14",
            checkpoint_digest: SHA_2,
            stream_digest: SHA_3,
            engine_state_schema: "engine-state/v1",
            encrypted_state_ref: BLOB_REF,
          },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const claimed = await store.claimNextRunV2("worker-1", {
      engine: ENGINE,
      restorableEngineStateSchemas: ["engine-state/v1"],
    });

    expect(claimed?.v2.restore).toEqual({
      attemptId: UUID_A,
      attemptPublicId: "arat_prior0123456789abcd",
      checkpointId: UUID_B,
      checkpointDigest: SHA_2,
      streamDigest: SHA_3,
      engineStateSchema: "engine-state/v1",
      encryptedStateRef: BLOB_REF,
      attemptSeq: 9,
      runSeq: 14,
    });
    // The successor keeps its OWN attempt identity.
    expect(claimed?.lease.attemptId).toBe(UUID_ATTEMPT);
    expect(claimed?.lease.attemptId).not.toBe(UUID_A);
    // attempt_seq restarts at 1 regardless of the restored position.
    expect(claimed?.checkpointSeq).toBe(0);
    expect(claimed?.checkpoint).toBeNull();
  });

  it("skips checkpoint restore entirely when the worker declares no parsable schema", async () => {
    const { tx, executed } = makeRoutingTx(claimRoutes());
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const claimed = await store.claimNextRunV2("worker-1", { engine: ENGINE });
    expect(claimed?.v2.restore).toBeNull();
    expect(ranSql(executed, SELECT_CHECKPOINT)).toBe(false);
  });

  it("refuses to retry past the pinned max_attempts", async () => {
    const routes = claimRoutes();
    routes[0] = {
      match: LOCK_RUN,
      rows: [
        {
          id: UUID_RUN,
          public_id: "arun_x",
          org_id: UUID_ORG,
          workspace_id: UUID_WS,
          surface: "repo-edit",
          spec: makeSpec(),
          attempt_count: 3,
          next_run_seq: 1,
          latest_checkpoint_id: null,
          ...makeIdentityRow(),
        },
      ],
    };
    const { tx, executed } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.claimNextRunV2("worker-1", { engine: ENGINE }),
    ).rejects.toThrow(/max_attempts/);
    expect(ranSql(executed, INSERT_ATTEMPT)).toBe(false);
  });

  it("throws rather than proceeding when the attempt insert returns no row", async () => {
    const routes = claimRoutes();
    routes[2] = { match: INSERT_ATTEMPT, rows: [] };
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.claimNextRunV2("worker-1", { engine: ENGINE }),
    ).rejects.toThrow(RunStoreStateError);
  });

  it("throws when the run could not be marked running", async () => {
    const routes = claimRoutes();
    routes[5] = { match: MARK_CLAIMED, rows: [] };
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.claimNextRunV2("worker-1", { engine: ENGINE }),
    ).rejects.toThrow(/could not be marked running/);
  });

  it("claimNextRun dispatches to V2 first, then falls back to V1", async () => {
    // No V2 work: the dispatcher must still hand back the queued V1 run.
    const routes = [
      ...claimRoutes({ run: [] }),
      {
        match: LEGACY_CLAIM,
        rows: [
          {
            id: "legacy-run",
            public_id: "arun_legacy",
            org_id: UUID_ORG,
            workspace_id: UUID_WS,
            surface: "chat",
            spec: { instruction: "hi" },
            attempts: 1,
            checkpoint: null,
            checkpoint_seq: 0,
          },
        ],
      },
    ];
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const claimed = await store.claimNextRun("worker-1", { engine: ENGINE });
    expect(claimed?.specVersion).toBe(1);
    expect(claimed?.publicId).toBe("arun_legacy");
    expect(claimed?.lease).toBeNull();
  });

  it("claimNextRun without an engine identity claims V1 only", async () => {
    const { tx, executed } = makeRoutingTx([
      {
        match: LEGACY_CLAIM,
        rows: [
          {
            id: "legacy-run",
            public_id: "arun_legacy",
            org_id: UUID_ORG,
            workspace_id: UUID_WS,
            surface: "chat",
            spec: {},
            attempts: 1,
            checkpoint: null,
            checkpoint_seq: 0,
          },
        ],
      },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const claimed = await store.claimNextRun("worker-1");
    expect(claimed?.specVersion).toBe(1);
    // A V2 attempt REQUIRES a pinned engine build digest, so there is no
    // "claim now, resolve the engine later" path.
    expect(ranSql(executed, LOCK_RUN)).toBe(false);
  });
});

describe("renewAttemptLease / isAttemptCancelRequested", () => {
  it("renews against a live lease and returns the new expiry", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow()] },
      { match: RENEW_LEASE, rows: [{ expires_at: OBSERVED_AT }] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const result = await store.renewAttemptLease(LEASE);
    expect(result.expiresAt).toEqual(new Date(OBSERVED_AT));
    // The guard is restated in the UPDATE's WHERE clause, not only in the lock.
    const renew = executed.find((e) => RENEW_LEASE.test(e.sql));
    expect(renew?.sql).toContain("lease_token =");
    expect(renew?.sql).toContain("lease_epoch =");
    expect(renew?.sql).toContain("fenced_at IS NULL");
  });

  it("refuses to renew AT expiry — the reclaimer owns an expired attempt", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow({ expired: true })] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(store.renewAttemptLease(LEASE)).rejects.toThrow(
      RunLeaseFencedError,
    );
    expect(ranSql(executed, RENEW_LEASE)).toBe(false);
  });

  it("refuses to renew a fenced attempt", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow({ fenced_at: OBSERVED_AT })] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(store.renewAttemptLease(LEASE)).rejects.toThrow(
      /may not write: fenced/,
    );
  });

  it("throws when the lease vanished between the lock and the update", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow()] },
      { match: RENEW_LEASE, rows: [] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(store.renewAttemptLease(LEASE)).rejects.toThrow(
      RunLeaseFencedError,
    );
  });

  it("gates the cancel check on the same fencing tuple as a write", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow({ fenced_at: OBSERVED_AT })] },
      { match: CANCEL_CHECK, rows: [{ cancel_requested: false }] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    // Answering "not cancelled" to a fenced attempt would tell it to continue.
    await expect(store.isAttemptCancelRequested(LEASE)).rejects.toThrow(
      RunLeaseFencedError,
    );
  });

  it("reports a live cancellation request", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow()] },
      { match: CANCEL_CHECK, rows: [{ cancel_requested: true }] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.isAttemptCancelRequested(LEASE)).toBe(true);
  });

  it("defaults to false when the run row is missing", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow()] },
      { match: CANCEL_CHECK, rows: [] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(await store.isAttemptCancelRequested(LEASE)).toBe(false);
  });
});

describe("appendAttemptBatch", () => {
  function appendRoutes(
    lease: LockedLeaseRow,
    opts: {
      firstRunSeq?: string;
      inserted?: unknown[];
      existing?: unknown[];
      checkpointRows?: unknown[];
      onCheckpointInsert?: () => unknown[];
    } = {},
  ): Route[] {
    return [
      { match: LOCK_LEASE, rows: [lease] },
      { match: SELECT_EXISTING_EVENTS, rows: opts.existing ?? [] },
      {
        match: ALLOCATE_RUN_SEQ,
        rows: [{ first_run_seq: opts.firstRunSeq ?? "1" }],
      },
      { match: INSERT_EVENTS, rows: opts.inserted ?? [] },
      {
        match: INSERT_CHECKPOINT,
        rows: opts.onCheckpointInsert ??
          opts.checkpointRows ?? [{ id: "cp-1" }],
      },
      { match: SET_LATEST_CHECKPOINT, rows: [{ id: UUID_RUN }] },
      { match: ADVANCE_LEASE, rows: [{ id: "lease-1" }] },
    ];
  }

  it("appends a fresh batch, allocates run sequences, and advances the lease in ONE transaction", async () => {
    const { tx, executed } = makeRoutingTx(
      appendRoutes(makeLeaseRow(), {
        firstRunSeq: "10",
        inserted: [
          { id: "e1", attempt_seq: 1, run_seq: "10" },
          { id: "e2", attempt_seq: 2, run_seq: "11" },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a"), toolEvent(2, "call_b")],
    });

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1); // one transaction
    expect(result.events.map((e) => e.runSeq)).toEqual(["10", "11"]);
    expect(result.events.every((e) => !e.idempotent)).toBe(true);
    expect(result.lastAttemptSeq).toBe(2);
    expect(result.lastRunSeq).toBe("11");
    expect(result.eventCount).toBe(2);
    expect(result.eventStreamDigest).toBe(
      foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, [
        prepareAttemptEvent(toolEvent(1, "call_a")),
        prepareAttemptEvent(toolEvent(2, "call_b")),
      ]),
    );
    expect(ranSql(executed, ALLOCATE_RUN_SEQ)).toBe(true);
    expect(ranSql(executed, ADVANCE_LEASE)).toBe(true);
  });

  it("matches returned rows on attempt_seq, not on RETURNING order", async () => {
    const { tx } = makeRoutingTx(
      appendRoutes(makeLeaseRow(), {
        firstRunSeq: "10",
        // Deliberately reversed: multi-row RETURNING order is not guaranteed.
        inserted: [
          { id: "e2", attempt_seq: 2, run_seq: "11" },
          { id: "e1", attempt_seq: 1, run_seq: "10" },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a"), toolEvent(2, "call_b")],
    });
    expect(result.events[0]).toMatchObject({ attemptSeq: 1, eventId: "e1" });
    expect(result.events[1]).toMatchObject({ attemptSeq: 2, eventId: "e2" });
  });

  it("throws when the insert does not return a row for a requested sequence", async () => {
    const { tx } = makeRoutingTx(
      appendRoutes(makeLeaseRow(), { firstRunSeq: "10", inserted: [] }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(1)] }),
    ).rejects.toThrow(RunStoreStateError);
  });

  it("throws when the run allocates no sequences", async () => {
    const routes = appendRoutes(makeLeaseRow());
    routes[2] = { match: ALLOCATE_RUN_SEQ, rows: [] };
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(1)] }),
    ).rejects.toThrow(/did not allocate run sequences/);
  });

  it("is idempotent for a crash retry with identical digests", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_a"));
    const lease = makeLeaseRow({
      last_attempt_seq: 1,
      last_run_seq: 10,
      event_count: 1,
      final_event_digest: first.eventDigest,
      event_stream_digest: foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, [
        first,
      ]),
    });
    const { tx, executed } = makeRoutingTx(
      appendRoutes(lease, {
        firstRunSeq: "11",
        existing: [
          {
            id: "e1",
            attempt_seq: 1,
            run_seq: "10",
            event_digest: first.eventDigest,
          },
        ],
        inserted: [{ id: "e2", attempt_seq: 2, run_seq: "11" }],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a"), toolEvent(2, "call_b")],
    });

    expect(result.events[0]).toMatchObject({
      attemptSeq: 1,
      runSeq: "10",
      eventId: "e1",
      idempotent: true, // returned, not re-inserted
    });
    expect(result.events[1]).toMatchObject({
      attemptSeq: 2,
      idempotent: false,
    });
    // Only ONE new sequence was allocated — the replay reused its own.
    const alloc = executed.find((e) => ALLOCATE_RUN_SEQ.test(e.sql));
    expect(alloc?.params).toContain(1);
    expect(result.eventCount).toBe(2);
  });

  it("makes a FULLY replayed batch a no-op that never rewinds the lease", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_a"));
    const lease = makeLeaseRow({
      last_attempt_seq: 5,
      last_run_seq: 20,
      event_count: 5,
      final_event_digest: SHA_3,
      event_stream_digest: SHA_2,
    });
    const { tx, executed } = makeRoutingTx(
      appendRoutes(lease, {
        existing: [
          {
            id: "e1",
            attempt_seq: 1,
            run_seq: "10",
            event_digest: first.eventDigest,
          },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a")],
    });

    // Pointers stay where they were: moving them backwards would let the next
    // append re-issue sequences the log already holds.
    expect(result.lastAttemptSeq).toBe(5);
    expect(result.lastRunSeq).toBe("20");
    expect(result.eventCount).toBe(5);
    expect(result.eventStreamDigest).toBe(SHA_2);
    expect(ranSql(executed, ALLOCATE_RUN_SEQ)).toBe(false);
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
    expect(ranSql(executed, ADVANCE_LEASE)).toBe(false);
  });

  it("throws RunEventIntegrityError and reports the security event AFTER rollback", async () => {
    const conflicts: unknown[] = [];
    const sink: RunSecurityEventSink = {
      recordEventSequenceConflict(event) {
        conflicts.push(event);
      },
    };
    const lease = makeLeaseRow({
      last_attempt_seq: 1,
      last_run_seq: 10,
      event_count: 1,
      final_event_digest: SHA_3,
    });
    const { tx, executed } = makeRoutingTx(
      appendRoutes(lease, {
        existing: [
          { id: "e1", attempt_seq: 1, run_seq: "10", event_digest: SHA_3 },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore({ securityEvents: sink });
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(1)] }),
    ).rejects.toThrow(RunEventIntegrityError);

    // Nothing was written, and the audit record survives the rollback because
    // the sink is called outside the transaction.
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      type: EVENT_SEQUENCE_CONFLICT_EVENT,
      orgId: UUID_ORG,
      workspaceId: UUID_WS,
      runId: UUID_RUN,
      attemptId: UUID_ATTEMPT,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      attemptSeq: 1,
      storedDigest: SHA_3,
    });
  });

  it("does not report a security event for a non-integrity failure", async () => {
    const conflicts: unknown[] = [];
    const sink: RunSecurityEventSink = {
      recordEventSequenceConflict(event) {
        conflicts.push(event);
      },
    };
    const { tx } = makeRoutingTx([
      { match: LOCK_LEASE, rows: [makeLeaseRow({ fenced_at: OBSERVED_AT })] },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore({ securityEvents: sink });
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(1)] }),
    ).rejects.toThrow(RunLeaseFencedError);
    expect(conflicts).toHaveLength(0);
  });

  it("rejects an unknown event type before opening a transaction", async () => {
    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeRoutingTx([]).tx),
    );
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [
          {
            attemptSeq: 1,
            eventType: "model.freeform",
            observedAt: OBSERVED_AT,
            payload: {},
          },
        ],
      }),
    ).rejects.toThrow(/Unknown run event type/);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("rejects a sequence gap before touching the run's allocator", async () => {
    const { tx, executed } = makeRoutingTx(
      appendRoutes(makeLeaseRow({ last_attempt_seq: 4 })),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(6)] }),
    ).rejects.toThrow(RunEventSequenceGapError);
    expect(ranSql(executed, ALLOCATE_RUN_SEQ)).toBe(false);
  });

  it("writes the checkpoint bound to the batch's final event, in the same transaction", async () => {
    const { tx, executed } = makeRoutingTx(
      appendRoutes(makeLeaseRow(), {
        firstRunSeq: "10",
        inserted: [
          { id: "e1", attempt_seq: 1, run_seq: "10" },
          { id: "e2", attempt_seq: 2, run_seq: "11" },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a"), toolEvent(2, "call_b")],
      checkpoint: {
        engineStateSchema: "engine-state/v1",
        checkpointDigest: SHA_2,
        encryptedStateRef: BLOB_REF,
      },
    });

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(result.checkpointId).toBe("cp-1");
    const cp = executed.find((e) => INSERT_CHECKPOINT.test(e.sql));
    expect(cp?.params).toContain("e2"); // bound to the FINAL event
    expect(cp?.params).toContain("11");
    // The store owns the stream digest, not the producer.
    expect(cp?.params).toContain(result.eventStreamDigest);
    expect(ranSql(executed, SET_LATEST_CHECKPOINT)).toBe(true);
  });

  it("rolls the whole batch back when the checkpoint insert fails", async () => {
    const routes = appendRoutes(makeLeaseRow(), {
      firstRunSeq: "10",
      inserted: [{ id: "e1", attempt_seq: 1, run_seq: "10" }],
    });
    routes[4] = {
      match: INSERT_CHECKPOINT,
      rows: () => {
        throw new Error("checkpoint blob unavailable");
      },
    };
    const { tx, executed } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [toolEvent(1)],
        checkpoint: {
          engineStateSchema: "engine-state/v1",
          checkpointDigest: SHA_2,
          encryptedStateRef: BLOB_REF,
        },
      }),
    ).rejects.toThrow(/checkpoint blob unavailable/);

    // The events insert and the failing checkpoint shared ONE withSystemDb
    // callback, so the real driver rolls the events back with it — and the
    // lease pointer was never advanced.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(ranSql(executed, INSERT_EVENTS)).toBe(true);
    expect(ranSql(executed, ADVANCE_LEASE)).toBe(false);
  });

  it("throws when the checkpoint insert returns no row", async () => {
    const routes = appendRoutes(makeLeaseRow(), {
      firstRunSeq: "10",
      inserted: [{ id: "e1", attempt_seq: 1, run_seq: "10" }],
      checkpointRows: [],
    });
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [toolEvent(1)],
        checkpoint: {
          engineStateSchema: "engine-state/v1",
          checkpointDigest: SHA_2,
          encryptedStateRef: BLOB_REF,
        },
      }),
    ).rejects.toThrow(/checkpoint insert returned no row/);
  });

  it("refuses a checkpoint with no event to bind it to", async () => {
    const { tx } = makeRoutingTx(appendRoutes(makeLeaseRow()));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [],
        checkpoint: {
          engineStateSchema: "engine-state/v1",
          checkpointDigest: SHA_2,
          encryptedStateRef: BLOB_REF,
        },
      }),
    ).rejects.toThrow(/requires at least one event/);
  });

  it("treats a re-requested checkpoint on a replayed event as idempotent when it agrees", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_a"));
    const { tx } = makeRoutingTx([
      {
        match: LOCK_LEASE,
        rows: [
          makeLeaseRow({
            last_attempt_seq: 1,
            last_run_seq: 10,
            event_count: 1,
            final_event_digest: first.eventDigest,
          }),
        ],
      },
      {
        match: SELECT_EXISTING_EVENTS,
        rows: [
          {
            id: "e1",
            attempt_seq: 1,
            run_seq: "10",
            event_digest: first.eventDigest,
          },
        ],
      },
      {
        match: /FROM agent\.agent_run_checkpoints\s+WHERE event_id/,
        rows: [{ id: "cp-1", checkpoint_digest: SHA_2 }],
      },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const result = await store.appendAttemptBatch({
      lease: LEASE,
      events: [toolEvent(1, "call_a")],
      checkpoint: {
        engineStateSchema: "engine-state/v1",
        checkpointDigest: SHA_2,
        encryptedStateRef: BLOB_REF,
      },
    });
    expect(result.checkpointId).toBe("cp-1");
  });

  it("treats a DISAGREEING replayed checkpoint as an integrity failure", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_a"));
    const { tx } = makeRoutingTx([
      {
        match: LOCK_LEASE,
        rows: [
          makeLeaseRow({
            last_attempt_seq: 1,
            last_run_seq: 10,
            event_count: 1,
            final_event_digest: first.eventDigest,
          }),
        ],
      },
      {
        match: SELECT_EXISTING_EVENTS,
        rows: [
          {
            id: "e1",
            attempt_seq: 1,
            run_seq: "10",
            event_digest: first.eventDigest,
          },
        ],
      },
      {
        match: /FROM agent\.agent_run_checkpoints\s+WHERE event_id/,
        rows: [{ id: "cp-1", checkpoint_digest: SHA_3 }],
      },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [toolEvent(1, "call_a")],
        checkpoint: {
          engineStateSchema: "engine-state/v1",
          checkpointDigest: SHA_2,
          encryptedStateRef: BLOB_REF,
        },
      }),
    ).rejects.toThrow(RunEventIntegrityError);
  });

  it("throws when a replayed checkpoint has no stored row", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_a"));
    const { tx } = makeRoutingTx([
      {
        match: LOCK_LEASE,
        rows: [
          makeLeaseRow({
            last_attempt_seq: 1,
            last_run_seq: 10,
            event_count: 1,
            final_event_digest: first.eventDigest,
          }),
        ],
      },
      {
        match: SELECT_EXISTING_EVENTS,
        rows: [
          {
            id: "e1",
            attempt_seq: 1,
            run_seq: "10",
            event_digest: first.eventDigest,
          },
        ],
      },
    ]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({
        lease: LEASE,
        events: [toolEvent(1, "call_a")],
        checkpoint: {
          engineStateSchema: "engine-state/v1",
          checkpointDigest: SHA_2,
          encryptedStateRef: BLOB_REF,
        },
      }),
    ).rejects.toThrow(/no stored row for event/);
  });

  it("throws when the lease was fenced between the lock and the pointer advance", async () => {
    const routes = appendRoutes(makeLeaseRow(), {
      firstRunSeq: "10",
      inserted: [{ id: "e1", attempt_seq: 1, run_seq: "10" }],
    });
    routes[6] = { match: ADVANCE_LEASE, rows: [] };
    const { tx } = makeRoutingTx(routes);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.appendAttemptBatch({ lease: LEASE, events: [toolEvent(1)] }),
    ).rejects.toThrow(RunLeaseFencedError);
  });
});

describe("sealAttempt", () => {
  function sealRoutes(
    lease: LockedLeaseRow,
    opts: { inserted?: unknown[]; handle?: unknown[] } = {},
  ): Route[] {
    return [
      { match: LOCK_LEASE, rows: [lease] },
      { match: SELECT_HANDLE, rows: opts.handle ?? [] },
      { match: SELECT_EXISTING_EVENTS, rows: [] },
      { match: ALLOCATE_RUN_SEQ, rows: [{ first_run_seq: "20" }] },
      {
        match: INSERT_EVENTS,
        rows: opts.inserted ?? [
          { id: "term-1", attempt_seq: 1, run_seq: "20" },
        ],
      },
      { match: ADVANCE_LEASE, rows: [{ id: "lease-1" }] },
      { match: FENCE_LEASE, rows: [{ id: "lease-1" }] },
      { match: INSERT_SEAL, rows: [{ id: "seal-1" }] },
      {
        match: INSERT_GRANT,
        rows: [{ id: "grant-1", public_id: "afg_0123456789abcdef0123" }],
      },
      { match: INSERT_OBLIGATION, rows: [{ id: "obl-1" }] },
      { match: FINISH_RUN, rows: [{ id: UUID_RUN }] },
    ];
  }

  it("closes the normal-completion crash window: seal + grant + obligation in ONE transaction", async () => {
    const { tx, executed } = makeRoutingTx(sealRoutes(makeLeaseRow()));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const handle = await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "completed",
      sealerWorkerId: "worker-1",
      terminalEvent: terminalEvent(1),
      result: { ok: true },
    });

    // A worker that finishes normally and then crashes cannot strand its
    // evidence: the obligation was already durable when the seal committed.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(ranSql(executed, FENCE_LEASE)).toBe(true);
    expect(ranSql(executed, INSERT_SEAL)).toBe(true);
    expect(ranSql(executed, INSERT_GRANT)).toBe(true);
    expect(ranSql(executed, INSERT_OBLIGATION)).toBe(true);
    expect(handle.alreadySealed).toBe(false);
    expect(handle.terminalStatus).toBe("completed");
  });

  it("copies the afg_ grant public id into the obligation as the submission id", async () => {
    const { tx, executed } = makeRoutingTx(sealRoutes(makeLeaseRow()));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const handle = await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "completed",
      sealerWorkerId: "worker-1",
      terminalEvent: terminalEvent(1),
    });

    expect(handle.grantPublicId).toBe("afg_0123456789abcdef0123");
    expect(handle.submissionId).toBe(handle.grantPublicId);
    const obligation = executed.find((e) => INSERT_OBLIGATION.test(e.sql));
    expect(obligation?.params).toContain("afg_0123456789abcdef0123");
  });

  it("mints a grant with NO expiry and exactly one capability", async () => {
    const { tx, executed } = makeRoutingTx(sealRoutes(makeLeaseRow()));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "completed",
      sealerWorkerId: "worker-1",
      terminalEvent: terminalEvent(1),
    });

    const grant = executed.find((e) => INSERT_GRANT.test(e.sql));
    // No expiry column is written because none exists: a KMS or storage outage
    // must never strand an obligation behind a grant that timed out.
    expect(grant?.sql).not.toMatch(/expires_at/);
    expect(grant?.params).toContain(FINALIZATION_GRANT_CAPABILITY);
    // The public id is minted INSIDE the seal transaction, so assert its shape
    // rather than a fixture value.
    expect(
      grant?.params.some(
        (p) => typeof p === "string" && /^afg_[0-9a-f]{22}$/.test(p),
      ),
    ).toBe(true);
  });

  it("appends the terminal event through the same contiguity and digest rules", async () => {
    const { tx, executed } = makeRoutingTx(sealRoutes(makeLeaseRow()));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const handle = await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "completed",
      sealerWorkerId: "worker-1",
      terminalEvent: terminalEvent(1),
    });

    expect(ranSql(executed, INSERT_EVENTS)).toBe(true);
    expect(handle.eventCount).toBe(1);
    expect(handle.finalEventDigest).toBe(
      prepareAttemptEvent(terminalEvent(1)).eventDigest,
    );
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("20"); // final run seq
    expect(seal?.params).toContain("worker");
  });

  it("refuses a non-terminal-stage event as the terminal event", async () => {
    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeRoutingTx([]).tx),
    );
    const store = createPostgresRunStore();
    await expect(
      store.sealAttempt({
        lease: LEASE,
        terminalStatus: "completed",
        sealerWorkerId: "worker-1",
        terminalEvent: toolEvent(1),
      }),
    ).rejects.toThrow(/is not a terminal-stage event/);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses `abandoned` — that is the reclaimer's status, not a worker's", async () => {
    mocks.withSystemDb.mockImplementation(
      makeWithSystemDbMock(makeRoutingTx([]).tx),
    );
    const store = createPostgresRunStore();
    await expect(
      store.sealAttempt({
        lease: LEASE,
        terminalStatus: "abandoned",
        sealerWorkerId: "worker-1",
      }),
    ).rejects.toThrow(/reclaimer's terminal status/);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("seals from the lease pointers when the terminal event was already appended", async () => {
    const lease = makeLeaseRow({
      last_attempt_seq: 7,
      last_run_seq: 31,
      event_count: 7,
      final_event_digest: SHA_3,
      event_stream_digest: SHA_2,
    });
    const { tx, executed } = makeRoutingTx(sealRoutes(lease));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const handle = await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "failed",
      reasonCode: "verification_failed",
      sealerWorkerId: "worker-1",
      error: "tests failed",
    });

    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
    expect(handle.eventCount).toBe(7);
    expect(handle.finalEventDigest).toBe(SHA_3);
    expect(handle.eventStreamDigest).toBe(SHA_2);
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("verification_failed");
    const finish = executed.find((e) => FINISH_RUN.test(e.sql));
    expect(finish?.params).toContain("failed");
    expect(finish?.params).toContain("tests failed");
  });

  it("returns the SAME handle for a duplicate seal instead of minting a second grant", async () => {
    const sealed = makeLeaseRow({
      seal_id: "seal-1",
      fenced_at: OBSERVED_AT,
      expired: true,
    });
    const { tx, executed } = makeRoutingTx(
      sealRoutes(sealed, {
        handle: [
          {
            seal_id: "seal-1",
            terminal_status: "completed",
            event_count: "3",
            final_event_digest: SHA_3,
            event_stream_digest: SHA_2,
            grant_id: "grant-1",
            grant_public_id: "afg_0123456789abcdef0123",
            obligation_id: "obl-1",
            submission_id: "afg_0123456789abcdef0123",
          },
        ],
      }),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const handle = await store.sealAttempt({
      lease: LEASE,
      terminalStatus: "completed",
      sealerWorkerId: "worker-1",
    });

    expect(handle.alreadySealed).toBe(true);
    expect(handle.submissionId).toBe("afg_0123456789abcdef0123");
    expect(handle.eventCount).toBe(3);
    expect(ranSql(executed, INSERT_GRANT)).toBe(false);
    expect(ranSql(executed, INSERT_SEAL)).toBe(false);
  });

  it("throws when a sealed attempt has no grant or obligation to hand back", async () => {
    const sealed = makeLeaseRow({ seal_id: "seal-1", fenced_at: OBSERVED_AT });
    const { tx } = makeRoutingTx(sealRoutes(sealed, { handle: [] }));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.sealAttempt({
        lease: LEASE,
        terminalStatus: "completed",
        sealerWorkerId: "worker-1",
      }),
    ).rejects.toThrow(/no finalization grant or obligation/);
  });

  it("refuses to seal an expired lease on the worker path", async () => {
    const { tx, executed } = makeRoutingTx(
      sealRoutes(makeLeaseRow({ expired: true })),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await expect(
      store.sealAttempt({
        lease: LEASE,
        terminalStatus: "completed",
        sealerWorkerId: "worker-1",
      }),
    ).rejects.toThrow(RunLeaseFencedError);
    expect(ranSql(executed, INSERT_SEAL)).toBe(false);
  });

  it("throws when the seal, grant, or obligation insert returns no row", async () => {
    for (const [pattern, message] of [
      [INSERT_SEAL, /seal insert returned no row/],
      [INSERT_GRANT, /finalization grant insert returned no row/],
      [INSERT_OBLIGATION, /finalization obligation insert returned no row/],
    ] as const) {
      const routes = sealRoutes(makeLeaseRow()).map((r) =>
        r.match === pattern ? { match: pattern, rows: [] } : r,
      );
      const { tx } = makeRoutingTx(routes);
      mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
      const store = createPostgresRunStore();
      await expect(
        store.sealAttempt({
          lease: LEASE,
          terminalStatus: "completed",
          sealerWorkerId: "worker-1",
        }),
      ).rejects.toThrow(message);
    }
  });
});

describe("reclaimExpiredAttempts", () => {
  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      attempt_id: UUID_ATTEMPT,
      run_id: UUID_RUN,
      lease_token: "token-1",
      lease_epoch: "4",
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      attempt_number: "1",
      max_attempts: "3",
      attempt_count: "1",
      ...overrides,
    };
  }

  function reclaimRoutes(
    lease: LockedLeaseRow,
    candidates: unknown[],
    handle: unknown[] = [],
  ): Route[] {
    return [
      { match: SELECT_EXPIRED, rows: candidates },
      { match: LOCK_LEASE, rows: [lease] },
      { match: SELECT_HANDLE, rows: handle },
      { match: FENCE_LEASE, rows: [{ id: "lease-1" }] },
      { match: INSERT_SEAL, rows: [{ id: "seal-1" }] },
      {
        match: INSERT_GRANT,
        rows: [{ id: "grant-1", public_id: "afg_0123456789abcdef0123" }],
      },
      { match: INSERT_OBLIGATION, rows: [{ id: "obl-1" }] },
      { match: REQUEUE_RUN, rows: [{ id: UUID_RUN }] },
      { match: FINISH_RUN, rows: [{ id: UUID_RUN }] },
    ];
  }

  it("seals a ZERO-EVENT abandoned attempt with the empty-stream sentinel and no invented event", async () => {
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true }), [candidate()]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));

    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-1",
    });

    expect(reclaimed?.handle.eventCount).toBe(0);
    expect(reclaimed?.handle.finalEventDigest).toBeNull();
    expect(reclaimed?.handle.eventStreamDigest).toBe(EMPTY_EVENT_STREAM_DIGEST);
    expect(reclaimed?.handle.terminalStatus).toBe("abandoned");
    // Inventing a terminal event would put an observation in the ledger that
    // no producer ever made.
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("reclaimer");
    expect(seal?.params).toContain("abandoned");
    expect(seal?.params).toContain("lease_expired");
    expect(seal?.params).toContain(EMPTY_EVENT_STREAM_DIGEST);
  });

  it("still mints the grant and obligation for a zero-event attempt", async () => {
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true }), [candidate()]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-1",
    });
    expect(ranSql(executed, INSERT_GRANT)).toBe(true);
    expect(ranSql(executed, INSERT_OBLIGATION)).toBe(true);
    expect(reclaimed?.handle.submissionId).toBe("afg_0123456789abcdef0123");
  });

  it("seals from the last ACCEPTED event when the attempt made progress", async () => {
    const lease = makeLeaseRow({
      expired: true,
      event_count: 4,
      last_run_seq: 21,
      last_attempt_seq: 4,
      final_event_digest: SHA_3,
      event_stream_digest: SHA_2,
    });
    const { tx, executed } = makeRoutingTx(reclaimRoutes(lease, [candidate()]));
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-1",
    });
    expect(reclaimed?.handle.eventCount).toBe(4);
    expect(reclaimed?.handle.finalEventDigest).toBe(SHA_3);
    expect(reclaimed?.handle.eventStreamDigest).toBe(SHA_2);
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("21");
    expect(seal?.params).toContain(4);
  });

  it("requeues the run for a successor while the pinned max_attempts permits", async () => {
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true }), [
        candidate({ attempt_count: "1", max_attempts: "3" }),
      ]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-1",
    });
    expect(reclaimed?.successorPermitted).toBe(true);
    expect(ranSql(executed, REQUEUE_RUN)).toBe(true);
    expect(ranSql(executed, FINISH_RUN)).toBe(false);
    // The successor ATTEMPT is created by the next claim: an attempt row pins a
    // resolved engine build digest only a claiming worker knows.
    expect(ranSql(executed, INSERT_ATTEMPT)).toBe(false);
  });

  it("fails the run after sealing the final attempt when the retry cap is exhausted", async () => {
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true }), [
        candidate({ attempt_count: "3", max_attempts: "3" }),
      ]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-1",
    });
    expect(reclaimed?.successorPermitted).toBe(false);
    // Sealed FIRST, then failed — the exhausted run stays evidence-finalizable.
    expect(ranSql(executed, INSERT_SEAL)).toBe(true);
    expect(ranSql(executed, REQUEUE_RUN)).toBe(false);
    const finish = executed.find((e) => FINISH_RUN.test(e.sql));
    expect(finish?.params).toContain("failed");
    expect(String(finish?.params)).toContain("max_attempts");
  });

  it("is idempotent under a duplicate sweep and does not re-mutate the run", async () => {
    const sealed = makeLeaseRow({
      expired: true,
      fenced_at: OBSERVED_AT,
      seal_id: "seal-1",
    });
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(
        sealed,
        [candidate()],
        [
          {
            seal_id: "seal-1",
            terminal_status: "abandoned",
            event_count: "0",
            final_event_digest: null,
            event_stream_digest: EMPTY_EVENT_STREAM_DIGEST,
            grant_id: "grant-1",
            grant_public_id: "afg_0123456789abcdef0123",
            obligation_id: "obl-1",
            submission_id: "afg_0123456789abcdef0123",
          },
        ],
      ),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const [reclaimed] = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-2",
    });
    expect(reclaimed?.handle.alreadySealed).toBe(true);
    expect(reclaimed?.handle.submissionId).toBe("afg_0123456789abcdef0123");
    expect(ranSql(executed, INSERT_SEAL)).toBe(false);
    expect(ranSql(executed, REQUEUE_RUN)).toBe(false);
    expect(ranSql(executed, FINISH_RUN)).toBe(false);
  });

  it("skips a lease another sweeper fenced but has not yet sealed", async () => {
    const { tx, executed } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true, fenced_at: OBSERVED_AT }), [
        candidate(),
      ]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    const reclaimed = await store.reclaimExpiredAttempts({
      reclaimerWorkerId: "sweeper-2",
    });
    expect(reclaimed).toHaveLength(0);
    expect(ranSql(executed, INSERT_SEAL)).toBe(false);
  });

  it("uses one transaction PER attempt so a poisoned row cannot roll back the sweep", async () => {
    const { tx } = makeRoutingTx(
      reclaimRoutes(makeLeaseRow({ expired: true }), [
        candidate(),
        candidate({ attempt_id: UUID_A }),
      ]),
    );
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    await store.reclaimExpiredAttempts({ reclaimerWorkerId: "sweeper-1" });
    // One for the candidate scan, one per reclaimed attempt.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(3);
  });

  it("returns an empty list when nothing has expired", async () => {
    const { tx } = makeRoutingTx([{ match: SELECT_EXPIRED, rows: [] }]);
    mocks.withSystemDb.mockImplementation(makeWithSystemDbMock(tx));
    const store = createPostgresRunStore();
    expect(
      await store.reclaimExpiredAttempts({ reclaimerWorkerId: "sweeper-1" }),
    ).toEqual([]);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });
});

describe("readAttemptEventsSince", () => {
  it("reads V2 events through withTenantDb and maps them in order", async () => {
    const { tx } = makeRoutingTx([
      {
        match: /e\.event_record_version = 2/,
        rows: [
          {
            id: "e1",
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: ATTEMPT_PUBLIC_ID,
            run_seq: "10",
            attempt_seq: 1,
            event_schema_version: EVENT_SCHEMA_VERSION,
            event_type: "tool.call_completed",
            stage: "tool",
            payload_digest: SHA_1,
            event_digest: SHA_2,
            payload_inline: { ok: true },
            encrypted_payload_ref: null,
            observed_at: OBSERVED_AT,
            created_at: OBSERVED_AT,
          },
        ],
      },
    ]);
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    const store = createPostgresRunStore();
    const events = await store.readAttemptEventsSince(UUID_RUN, "9");
    expect(events).toHaveLength(1);
    expect(events[0]?.runSeq).toBe("10");
    expect(events[0]?.stage).toBe("tool");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

// ── Typed error guards ──────────────────────────────────────────────────────

describe("V2 error guards", () => {
  it("match their own errors by instance", () => {
    expect(
      isUnknownRunEventTypeError(new UnknownRunEventTypeError("x", ["y"])),
    ).toBe(true);
    expect(
      isForbiddenEventPayloadFieldError(
        new ForbiddenEventPayloadFieldError("x", ["path"]),
      ),
    ).toBe(true);
    expect(
      isRunEventPayloadTooLargeError(
        new RunEventPayloadTooLargeError("x", 1, 0),
      ),
    ).toBe(true);
    expect(
      isRunEventIntegrityError(
        new RunEventIntegrityError(UUID_ATTEMPT, 1, SHA_1, SHA_2),
      ),
    ).toBe(true);
    expect(
      isRunEventSequenceGapError(
        new RunEventSequenceGapError(UUID_ATTEMPT, 2, 5),
      ),
    ).toBe(true);
    expect(
      isRunLeaseFencedError(new RunLeaseFencedError(UUID_ATTEMPT, "fenced")),
    ).toBe(true);
    expect(isRunStoreStateError(new RunStoreStateError("bad"))).toBe(true);
  });

  it("match structurally across a duplicated class identity", () => {
    // A bundler can produce two copies of a class; the `code` discriminant is
    // what keeps an `instanceof`-based catch working across that boundary.
    const structural = Object.assign(new Error("copy"), {
      code: "run_event_integrity_conflict",
    });
    expect(isRunEventIntegrityError(structural)).toBe(true);
    expect(
      isRunLeaseFencedError(
        Object.assign(new Error("copy"), { code: "run_lease_fenced" }),
      ),
    ).toBe(true);
  });

  it("do not match unrelated errors", () => {
    const other = new Error("nope");
    expect(isUnknownRunEventTypeError(other)).toBe(false);
    expect(isForbiddenEventPayloadFieldError(other)).toBe(false);
    expect(isRunEventPayloadTooLargeError(other)).toBe(false);
    expect(isRunEventIntegrityError(other)).toBe(false);
    expect(isRunEventSequenceGapError(other)).toBe(false);
    expect(isRunLeaseFencedError(other)).toBe(false);
    expect(isRunStoreStateError(other)).toBe(false);
    expect(isRunStoreStateError("not an error")).toBe(false);
  });

  it("carry a stable code and a diagnostic message", () => {
    const integrity = new RunEventIntegrityError(UUID_ATTEMPT, 3, SHA_1, SHA_2);
    expect(integrity.code).toBe("run_event_integrity_conflict");
    expect(integrity.message).toContain("seq 3");
    expect(new RunLeaseFencedError(UUID_ATTEMPT, "sealed").code).toBe(
      "run_lease_fenced",
    );
    expect(new UnknownRunEventTypeError("x", ["a", "b"]).message).toContain(
      "a, b",
    );
    expect(
      new ForbiddenEventPayloadFieldError("x", ["a.path"]).message,
    ).toContain("a.path");
  });
});
