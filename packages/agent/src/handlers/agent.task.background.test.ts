import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // DB chain for SELECT
  selectResult: vi.fn(),
  selectSpy: vi.fn(),
  selectFrom: vi.fn(),
  selectWhere: vi.fn(),
  selectLimit: vi.fn(),
  // DB chain for INSERT
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  insertSpy: vi.fn(),
  // DB chain for UPDATE
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateSpy: vi.fn(),
  // Inngest send
  inngestSend: vi.fn(async () => undefined),
}));

// SELECT chain
mocks.selectLimit.mockImplementation(async (): Promise<unknown> => mocks.selectResult() as unknown);
mocks.selectWhere.mockReturnValue({ limit: mocks.selectLimit });
mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
mocks.selectSpy.mockReturnValue({ from: mocks.selectFrom });

// INSERT chain: returning() yields the task publicId
mocks.insertReturning.mockImplementation(async () => [{ publicId: "task_pub_1" }]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.insertSpy.mockReturnValue({ values: mocks.insertValues });

// UPDATE chain
mocks.updateWhere.mockResolvedValue(undefined);
mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
mocks.updateSpy.mockReturnValue({ set: mocks.updateSet });

const fakeDb = {
  select: mocks.selectSpy,
  insert: mocks.insertSpy,
  update: mocks.updateSpy,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: () => fakeDb,
  withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),

  };
});

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test" }),
}));

// Stub Inngest so we never touch the real Inngest cloud
vi.mock("inngest", () => ({
  Inngest: vi.fn().mockImplementation(() => ({
    send: mocks.inngestSend,
  })),
}));

import { agentTaskBackgroundStartHandler } from "./agent.task.background.start";
import { agentTaskBackgroundReadHandler } from "./agent.task.background.read";
import { agentTaskBackgroundCancelHandler } from "./agent.task.background.cancel";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "../test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

describe("agentTaskBackgroundStartHandler", () => {
  beforeEach(() => {
    mocks.insertSpy.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertReturning.mockClear();
    mocks.inngestSend.mockClear();
    // Restore default
    mocks.insertReturning.mockImplementation(async () => [{ publicId: "task_pub_1" }]);
  });

  it("inserts a backgroundTask row and fires an Inngest event", async () => {
    const result = await agentTaskBackgroundStartHandler(
      { kind: "export", label: "Export run", payload: { format: "csv" } },
      CTX,
    );

    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);

    const inngestArg = (mocks.inngestSend.mock.calls[0] as [Record<string, unknown>])[0];
    expect(inngestArg.name).toBe("agent/task.background.start");
    const data = inngestArg.data as Record<string, unknown>;
    expect(data.orgId).toBe("org_1");
    expect(data.workspaceId).toBe("ws_1");
    expect(data.kind).toBe("export");

    expect(result.taskId).toBe("task_pub_1");
    expect(typeof result.inngestRunId).toBe("string");
    expect(result.inngestRunId.startsWith("bgt_")).toBe(true);
  });

  it("throws when the insert returns no row", async () => {
    mocks.insertReturning.mockImplementationOnce(async () => []);

    await expect(
      agentTaskBackgroundStartHandler({ kind: "export", payload: null }, CTX),
    ).rejects.toThrow("background_tasks insert failed");
  });

  it("inserts with orgId and workspaceId scoped from context", async () => {
    await agentTaskBackgroundStartHandler({ kind: "my-task", payload: {} }, CTX);

    const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.orgId).toBe("org_1");
    expect(valuesArg.workspaceId).toBe("ws_1");
    expect(valuesArg.createdByUserId).toBe("u_1");
    expect(valuesArg.status).toBe("pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

describe("agentTaskBackgroundReadHandler", () => {
  beforeEach(() => {
    mocks.selectSpy.mockClear();
    mocks.selectResult.mockClear();
  });

  const taskRow = {
    publicId: "task_pub_1",
    kind: "export",
    status: "running",
    label: "My export",
    resultPayload: null,
    failureReason: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    startedAt: new Date("2026-05-01T00:01:00Z"),
    completedAt: null,
  };

  it("returns the task row mapped to the expected output shape", async () => {
    mocks.selectResult.mockReturnValueOnce([taskRow]);

    const result = await agentTaskBackgroundReadHandler({ taskId: "task_pub_1" }, CTX);

    expect(result.taskId).toBe("task_pub_1");
    expect(result.kind).toBe("export");
    expect(result.status).toBe("running");
    expect(result.label).toBe("My export");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
    expect(result.startedAt).toBe("2026-05-01T00:01:00.000Z");
    expect(result.completedAt).toBeNull();
  });

  it("throws when the task is not found (tenant guard)", async () => {
    mocks.selectResult.mockReturnValueOnce([]);

    await expect(
      agentTaskBackgroundReadHandler({ taskId: "task_missing" }, CTX),
    ).rejects.toThrow("Background task task_missing not found");
  });

  it("queries with orgId and workspaceId from context (tenant isolation)", async () => {
    mocks.selectResult.mockReturnValue([taskRow]);
    const beforeSelect = mocks.selectSpy.mock.calls.length;
    const beforeWhere = mocks.selectWhere.mock.calls.length;
    await agentTaskBackgroundReadHandler({ taskId: "task_pub_1" }, CTX);
    expect(mocks.selectSpy.mock.calls.length - beforeSelect).toBe(1);
    expect(mocks.selectWhere.mock.calls.length - beforeWhere).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL
// ─────────────────────────────────────────────────────────────────────────────

describe("agentTaskBackgroundCancelHandler", () => {
  beforeEach(() => {
    mocks.selectSpy.mockClear();
    mocks.selectResult.mockClear();
    mocks.updateSpy.mockClear();
    mocks.inngestSend.mockClear();
  });

  it("cancels a pending task and fires Inngest cancel event", async () => {
    mocks.selectResult.mockReturnValueOnce([{ id: "internal_id_1", status: "pending" }]);

    const result = await agentTaskBackgroundCancelHandler(
      { taskId: "task_pub_1", reason: "user requested" },
      CTX,
    );

    expect(result.taskId).toBe("task_pub_1");
    expect(result.status).toBe("cancelled");
    expect(mocks.updateSpy).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);

    const inngestArg = (mocks.inngestSend.mock.calls[0] as [Record<string, unknown>])[0];
    expect(inngestArg.name).toBe("agent/task.background.cancel");
    const data = inngestArg.data as Record<string, unknown>;
    expect(data.orgId).toBe("org_1");
    expect(data.taskId).toBe("task_pub_1");
  });

  it("returns already_completed without DB update when task is completed", async () => {
    mocks.selectResult.mockReturnValueOnce([{ id: "id_2", status: "completed" }]);

    const result = await agentTaskBackgroundCancelHandler(
      { taskId: "task_done" },
      CTX,
    );

    expect(result.status).toBe("already_completed");
    expect(mocks.updateSpy).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns already_cancelled without DB update when task is already cancelled", async () => {
    mocks.selectResult.mockReturnValueOnce([{ id: "id_3", status: "cancelled" }]);

    const result = await agentTaskBackgroundCancelHandler(
      { taskId: "task_cancelled" },
      CTX,
    );

    expect(result.status).toBe("already_cancelled");
    expect(mocks.updateSpy).not.toHaveBeenCalled();
  });

  it("throws when the task is not found (tenant guard)", async () => {
    mocks.selectResult.mockReturnValueOnce([]);

    await expect(
      agentTaskBackgroundCancelHandler({ taskId: "task_ghost" }, CTX),
    ).rejects.toThrow("Background task task_ghost not found");
  });

  it("queries with orgId from context (tenant isolation)", async () => {
    mocks.selectResult.mockReturnValue([{ id: "id_4", status: "running" }]);
    const beforeSelect = mocks.selectSpy.mock.calls.length;
    const beforeWhere = mocks.selectWhere.mock.calls.length;
    await agentTaskBackgroundCancelHandler({ taskId: "task_pub_1" }, CTX);
    expect(mocks.selectSpy.mock.calls.length - beforeSelect).toBe(1);
    expect(mocks.selectWhere.mock.calls.length - beforeWhere).toBe(1);
  });
});
