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
} from "./run-store";

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
