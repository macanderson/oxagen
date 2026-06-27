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

const { mockInsertEvents } = vi.hoisted(() => ({
  mockInsertEvents: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@oxagen/telemetry", () => ({
  insertEvents: mockInsertEvents,
}));

import { agentCodeExecuteHandler } from "./agent.code.execute";
import { isSandboxAvailable, getSandbox } from "@oxagen/sandbox";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.code.execute handler", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockInsertEvents.mockClear();
    mockInsertEvents.mockResolvedValue(undefined);
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

  it("meters the run to ClickHouse with language and duration", async () => {
    mockRun.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 4242,
      timedOut: false,
      oomKilled: false,
    });

    await agentCodeExecuteHandler(
      { language: "python", code: "print(1)", timeoutMs: 5_000, memoryMb: 128, network: "deny" },
      CTX,
    );

    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertEvents.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe("agent.code.execute.ran");
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
    expect(payload.language).toBe("python");
    expect(payload.durationMs).toBe(4242);
    expect(payload.exitCode).toBe(0);
  });

  it("never fails the run when telemetry throws", async () => {
    mockInsertEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    const result = await agentCodeExecuteHandler(
      { language: "node", code: "x", timeoutMs: 5_000, memoryMb: 64, network: "deny" },
      CTX,
    );
    expect(result.exitCode).toBe(0);
  });

  it("strips reserved/host env keys before reaching the sandbox", async () => {
    await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo hi",
        env: {
          SAFE_VALUE: "keep",
          PATH: "/evil/bin",
          LD_PRELOAD: "/evil.so",
          MODAL_TOKEN: "stolen",
          "bad-key": "dropped",
        },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ env: { SAFE_VALUE: "keep" } }),
    );
  });

  it("lands a multi-file workspace into the sandbox before running", async () => {
    await agentCodeExecuteHandler(
      {
        language: "node",
        code: "require('./util')",
        files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
        timeoutMs: 5_000,
        memoryMb: 128,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
      }),
    );
  });

  it("rejects a path-traversal file at the sandbox boundary (defense in depth)", async () => {
    await expect(
      agentCodeExecuteHandler(
        {
          language: "node",
          code: "x",
          files: { "../escape.js": "evil" },
          timeoutMs: 5_000,
          memoryMb: 64,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow(/unsafe workspace path/);
    expect(mockRun).not.toHaveBeenCalled();
  });
});
