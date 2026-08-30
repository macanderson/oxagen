import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertExecutionLogsMock: vi.fn(),
}));

mocks.insertExecutionLogsMock.mockImplementation(async () => undefined);

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertExecutionLogs: mocks.insertExecutionLogsMock,
  };
});

import { beforeTool, afterTool, onError } from "./runtime";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("hooks runtime", () => {
  beforeEach(() => {
    mocks.insertExecutionLogsMock.mockReset();
    mocks.insertExecutionLogsMock.mockResolvedValue(undefined);
  });

  it("beforeTool writes one execution_logs row with info level", async () => {
    await beforeTool({
      ctx: CTX,
      capability: "execute_code",
      input: { code: "x" },
    });
    expect(mocks.insertExecutionLogsMock).toHaveBeenCalledTimes(1);
    const row = (
      mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(row.log_level).toBe("info");
    expect(row.org_id).toBe("ten_1");
    expect(row.workspace_id).toBe("ws_1");
  });

  it("afterTool writes execution_logs", async () => {
    await afterTool({
      ctx: CTX,
      capability: "execute_code",
      output: { ok: true },
    });
    expect(mocks.insertExecutionLogsMock).toHaveBeenCalledTimes(1);
  });

  // Regression: step_id is a Nullable(UUID) column. The hook must send NULL,
  // never "" — ClickHouse cannot parse an empty string as a UUID and fails the
  // entire row insert (CANNOT_PARSE_INPUT_ASSERTION_FAILED).
  it("omits step_id as null (not empty string) when no stepId is provided", async () => {
    await beforeTool({ ctx: CTX, capability: "generate_svg" });
    const row = (
      mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(row.step_id).toBeNull();
    expect(row.step_id).not.toBe("");
  });

  it("passes a provided stepId through to step_id", async () => {
    const stepId = "f0d3c4b2-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    await beforeTool({ ctx: CTX, capability: "generate_svg", stepId });
    const row = (
      mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(row.step_id).toBe(stepId);
  });

  it("onError writes execution_logs with error level", async () => {
    await onError({
      ctx: CTX,
      capability: "execute_code",
      error: new Error("boom"),
    });
    const row = (
      mocks.insertExecutionLogsMock.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(row.log_level).toBe("error");
    expect(String(row.metadata)).toContain("boom");
  });

  it("hook still resolves when telemetry client throws (failure-isolated)", async () => {
    mocks.insertExecutionLogsMock.mockRejectedValueOnce(
      new Error("clickhouse down"),
    );
    await expect(
      beforeTool({ ctx: CTX, capability: "execute_code" }),
    ).resolves.toBeUndefined();
  });
});
