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
  withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
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
} from "./approval";

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
    const calls = executeSpy.mock.calls as unknown as Array<[{ queryChunks: unknown[] }]>;
    const sqlObj = calls[0]?.[0];
    // The drizzle sql tagged-template produces an object with queryChunks, not a raw string.
    expect(sqlObj).toBeTruthy();
    expect(sqlObj).toHaveProperty("queryChunks");
    // Drizzle sql chunk shape: literal text chunks are { value: string[] },
    // bound parameter chunks are plain strings.
    const chunks = sqlObj!.queryChunks as Array<{ value?: string[] } | string>;
    // Static SQL text (from literal parts) must contain pg_notify.
    const staticText = chunks
      .flatMap((c) => (typeof c === "object" && Array.isArray(c.value) ? c.value : []))
      .join("");
    expect(staticText).toContain("pg_notify");
    // Bound params are plain strings — channel name must appear as a param.
    const boundParams = chunks.filter((c): c is string => typeof c === "string");
    expect(boundParams).toContain("agent_approval_resolved");
    // Payload param must contain the approval id and round-trip as JSON.
    const payloadParam = boundParams.find((v) => v.includes("appr_1"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as { approvalId: string; resolution: string };
    expect(parsed.approvalId).toBe("appr_1");
    expect(parsed.resolution).toBe("approved");
  });

  it("notifyResolution: hostile note with SQL metacharacters does not corrupt query or payload", async () => {
    const hostileNote = "it's a test; -- ') DROP TABLE approvals; --";
    await notifyResolution({
      approvalId: "appr_hostile",
      resolution: "denied",
      note: hostileNote,
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const calls = executeSpy.mock.calls as unknown as Array<[{ queryChunks: unknown[] }]>;
    const sqlObj = calls[0]?.[0];
    expect(sqlObj).toHaveProperty("queryChunks");
    const chunks = sqlObj!.queryChunks as Array<{ value?: string[] } | string>;
    // Static SQL text (literal parts) must NOT contain any hostile content.
    const staticText = chunks
      .flatMap((c) => (typeof c === "object" && Array.isArray(c.value) ? c.value : []))
      .join("");
    expect(staticText).not.toContain(hostileNote);
    expect(staticText).not.toContain("DROP TABLE");
    // Payload is a plain-string bound parameter — find it and verify it round-trips.
    const boundParams = chunks.filter((c): c is string => typeof c === "string");
    const payloadParam = boundParams.find((v) => v.includes("appr_hostile"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as {
      approvalId: string;
      resolution: string;
      note: string;
    };
    expect(parsed.approvalId).toBe("appr_hostile");
    expect(parsed.resolution).toBe("denied");
    // note is preserved exactly — including every hostile character — without escaping or truncation.
    expect(parsed.note).toBe(hostileNote);
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
