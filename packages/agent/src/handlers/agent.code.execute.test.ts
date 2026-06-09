import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SandboxResult, SandboxDriver } from "@oxagen/sandbox";

const mockSandboxResult: SandboxResult = {
  exitCode: 0,
  stdout: "hello world\n",
  stderr: "",
  durationMs: 123,
  timedOut: false,
  oomKilled: false,
};

const mockRun = vi.fn(async (): Promise<SandboxResult> => mockSandboxResult);

const mockDriver: SandboxDriver = {
  name: "mock",
  run: mockRun,
  async *stream() {},
};

vi.mock("@oxagen/sandbox", () => ({
  isSandboxAvailable: vi.fn(() => true),
  getSandbox: vi.fn((): SandboxDriver => mockDriver),
}));

import { agentCodeExecuteHandler } from "./agent.code.execute";
import { isSandboxAvailable, getSandbox } from "@oxagen/sandbox";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.code.execute handler", () => {
  beforeEach(() => {
    mockRun.mockClear();
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
    vi.mocked(getSandbox).mockReturnValue(mockDriver);
  });

  it("returns sandbox result mapped to contract output", async () => {
    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: 'console.log("hello world")',
        timeoutMs: 10_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello world\n",
      stderr: "",
      executionMs: 123,
      timedOut: false,
      oomKilled: false,
    });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "node",
        code: 'console.log("hello world")',
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    );
  });

  it("throws when sandbox is unavailable", async () => {
    vi.mocked(isSandboxAvailable).mockReturnValue(false);

    await expect(
      agentCodeExecuteHandler(
        {
          language: "python",
          code: "print('hi')",
          timeoutMs: 5_000,
          memoryMb: 128,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow("Code execution is not available");
  });

  it("passes env vars and stdin to sandbox", async () => {
    await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo $GREETING",
        stdin: "ignored by shell",
        env: { GREETING: "hi" },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { GREETING: "hi" },
        stdin: "ignored by shell",
        network: "deny",
      }),
    );
  });

  it("surfaces timed-out and oom-killed flags from sandbox result", async () => {
    mockRun.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "killed",
      durationMs: 30_001,
      timedOut: true,
      oomKilled: false,
    });

    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "while(true){}",
        timeoutMs: 30_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});
