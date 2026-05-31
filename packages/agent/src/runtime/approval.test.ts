import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture row inserted via the spy chain so the test can assert the shape.
const insertedValues: unknown[] = [];
const executeSpy = vi.fn(async () => undefined);

const returningMock = vi.fn(async () => [{ id: "appr_123" }]);
const valuesMock = vi.fn((v: unknown) => {
  insertedValues.push(v);
  return { returning: returningMock };
});
const insertMock = vi.fn(() => ({ values: valuesMock }));

const limitMock = vi.fn(async () => [{ id: "appr_123", orgId: "ten_1" }]);
const whereMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

const fakeDb = {
  insert: insertMock,
  select: selectMock,
  execute: executeSpy,
};

vi.mock("@oxagen/database", () => ({
  db: () => fakeDb,
  schema: {
    approvalRequests: {
      id: "id",
      orgId: "orgId",
      expiresAt: "expiresAt",
      resolution: "resolution",
    },
  },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ DATABASE_URL: "postgres://test" }),
}));

// Postgres listen client: capture the handler so we can fire synthetic NOTIFY.
const listenHandlers: Array<(payload: string) => void> = [];
const listenMock = vi.fn(async (_channel: string, handler: (p: string) => void) => {
  listenHandlers.push(handler);
});
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ listen: listenMock })),
}));

import {
  createApprovalRequest,
  notifyResolution,
  waitForApproval,
  readApproval,
} from "./approval.js";

describe("approval runtime", () => {
  beforeEach(() => {
    insertedValues.length = 0;
    insertMock.mockClear();
    valuesMock.mockClear();
    returningMock.mockClear();
    executeSpy.mockClear();
    selectMock.mockClear();
    whereMock.mockClear();
  });

  it("createApprovalRequest inserts row with computed expiresAt", async () => {
    const before = Date.now();
    const res = await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "agent.code.execute",
      inputPreview: { foo: "bar" },
      riskLevel: "high",
      ttlMs: 10_000,
    });
    expect(res.approvalId).toBe("appr_123");
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertedValues[0] as {
      capabilityName: string;
      inputPreview: unknown;
      riskLevel: string;
      expiresAt: Date;
    };
    expect(row.capabilityName).toBe("agent.code.execute");
    expect(row.inputPreview).toEqual({ foo: "bar" });
    expect(row.riskLevel).toBe("high");
    expect(row.expiresAt).toBeInstanceOf(Date);
    const delta = row.expiresAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(10_000 - 50);
    expect(delta).toBeLessThanOrEqual(10_000 + 1000);
  });

  it("notifyResolution issues pg_notify on the approval channel", async () => {
    await notifyResolution({ approvalId: "appr_1", resolution: "approved", note: null });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const calls = executeSpy.mock.calls as unknown as Array<[unknown]>;
    const sql = String(calls[0]?.[0] ?? "");
    expect(sql).toContain("pg_notify");
    expect(sql).toContain("agent_approval_resolved");
    expect(sql).toContain("appr_1");
    expect(sql).toContain("approved");
  });

  it("waitForApproval resolves on NOTIFY for the matching id", async () => {
    const promise = waitForApproval("appr_wait_1", 60_000);
    // Allow ensureListener to register the handler.
    await new Promise((r) => setTimeout(r, 0));
    const handler = listenHandlers[listenHandlers.length - 1]!;
    handler(
      JSON.stringify({ approvalId: "appr_wait_1", resolution: "approved", note: null }),
    );
    const res = await promise;
    expect(res.approvalId).toBe("appr_wait_1");
    expect(res.resolution).toBe("approved");
  });

  it("waitForApproval times out as expired after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const promise = waitForApproval("appr_timeout_1", 5_000);
      // Flush any synchronous microtasks (listener already started).
      await Promise.resolve();
      vi.advanceTimersByTime(5_001);
      const res = await promise;
      expect(res.resolution).toBe("expired");
      expect(res.approvalId).toBe("appr_timeout_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("readApproval shapes select with id + orgId filters", async () => {
    const row = await readApproval("appr_1", "ten_1");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(row).toEqual({ id: "appr_123", orgId: "ten_1" });
  });
});
