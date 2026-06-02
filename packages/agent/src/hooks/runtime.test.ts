import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertExecutionLogsMock: vi.fn(),
}));

mocks.insertExecutionLogsMock.mockImplementation(async () => undefined);

vi.mock("@oxagen/telemetry", () => ({
  insertExecutionLogs: mocks.insertExecutionLogsMock,
}));

import { beforeTool, afterTool, onError } from "./runtime";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("hooks runtime", () => {
  beforeEach(() => {
    mocks.insertExecutionLogsMock.mockReset();
    mocks.insertExecutionLogsMock.mockResolvedValue(undefined);
  });

  it("beforeTool writes one execution_logs row with info level", async () => {
    await beforeTool({ ctx: CTX, capability: "agent.code.execute", input: { code: "x" } });
    expect(mocks.insertExecutionLogsMock).toHaveBeenCalledTimes(1);
    const row = (mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]!;
    expect(row.log_level).toBe("info");
    expect(row.org_id).toBe("ten_1");
    expect(row.workspace_id).toBe("ws_1");
  });

  it("afterTool writes execution_logs", async () => {
    await afterTool({ ctx: CTX, capability: "agent.code.execute", output: { ok: true } });
    expect(mocks.insertExecutionLogsMock).toHaveBeenCalledTimes(1);
  });

  it("onError writes execution_logs with error level", async () => {
    await onError({ ctx: CTX, capability: "agent.code.execute", error: new Error("boom") });
    const row = (mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]!;
    expect(row.log_level).toBe("error");
    expect(String(row.metadata)).toContain("boom");
  });

  it("hook still resolves when telemetry client throws (failure-isolated)", async () => {
    mocks.insertExecutionLogsMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      beforeTool({ ctx: CTX, capability: "agent.code.execute" }),
    ).resolves.toBeUndefined();
  });
});
