import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sandboxRun: vi.fn(),
  getSandboxMock: vi.fn(),
  applyPolicyMock: vi.fn(),
  // OXA-1425: insertToolInvocation is NOT called inside the handler; the
  // materialize-tools wrapper is the sole writer. We still mock the module
  // to detect any accidental re-introduction of a second write.
  insertToolInvocationMock: vi.fn(async () => undefined),
}));
const { sandboxRun, getSandboxMock, applyPolicyMock, insertToolInvocationMock } = mocks;

getSandboxMock.mockImplementation(() => ({ run: sandboxRun }));
applyPolicyMock.mockImplementation((req: Record<string, unknown>) => ({
  ...req,
  timeoutMs: Math.min((req.timeoutMs as number) ?? 30_000, 30_000),
  memoryMb: Math.min((req.memoryMb as number) ?? 512, 512),
}));

vi.mock("@oxagen/sandbox", () => ({
  getSandbox: mocks.getSandboxMock,
  applyPolicy: mocks.applyPolicyMock,
  DEFAULT_POLICY: { allowedLanguages: ["node"], maxTimeoutMs: 30_000, maxMemoryMb: 512, allowNetwork: false },
}));

vi.mock("@oxagen/telemetry", () => ({
  insertToolInvocation: mocks.insertToolInvocationMock,
}));

import { agentCodeExecuteHandler } from "./agent.code.execute";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("agent.code.execute handler", () => {
  beforeEach(() => {
    sandboxRun.mockReset();
    insertToolInvocationMock.mockReset();
    insertToolInvocationMock.mockResolvedValue(undefined);
    applyPolicyMock.mockClear();
    getSandboxMock.mockClear();
  });

  it("applies policy and forwards the request to the sandbox", async () => {
    sandboxRun.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 12,
      timedOut: false,
      oomKilled: false,
    });
    const res = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "console.log(1)",
        timeoutMs: 5_000,
        memoryMb: 128,
        network: "deny",
      },
      CTX,
    );
    expect(applyPolicyMock).toHaveBeenCalledTimes(1);
    const reqArg = applyPolicyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reqArg.orgId).toBe("ten_1");
    expect(reqArg.workspaceId).toBe("ws_1");
    expect(sandboxRun).toHaveBeenCalledTimes(1);
    expect(res.stdout).toBe("ok");
  });

  it("does NOT write a tool_invocations row — materialize-tools is the sole writer (OXA-1425)", async () => {
    // This is the key regression guard: exactly ZERO calls to insertToolInvocation
    // from the handler itself. materialize-tools.ts records the single row with
    // real latency; a second write here would double-count every code.execute call
    // in the billing rollup.
    sandboxRun.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "1\n",
      stderr: "",
      durationMs: 8,
      timedOut: false,
      oomKilled: false,
    });
    await agentCodeExecuteHandler(
      { language: "node", code: "console.log(1)", timeoutMs: 5_000, memoryMb: 128, network: "deny" },
      CTX,
    );
    expect(insertToolInvocationMock).toHaveBeenCalledTimes(0);
  });

  it("propagates policy violation errors", async () => {
    applyPolicyMock.mockImplementationOnce(() => {
      throw new Error("language not allowed");
    });
    await expect(
      agentCodeExecuteHandler(
        {
          language: "node",
          code: "x",
          timeoutMs: 1_000,
          memoryMb: 64,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow(/language not allowed/);
  });

  it("passes through timedOut and oomKilled flags", async () => {
    sandboxRun.mockResolvedValueOnce({
      exitCode: 137,
      stdout: "",
      stderr: "Killed",
      durationMs: 30_000,
      timedOut: true,
      oomKilled: true,
    });
    const res = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "while(true){}",
        timeoutMs: 30_000,
        memoryMb: 512,
        network: "deny",
      },
      CTX,
    );
    expect(res.timedOut).toBe(true);
    expect(res.oomKilled).toBe(true);
    expect(res.exitCode).toBe(137);
  });
});
