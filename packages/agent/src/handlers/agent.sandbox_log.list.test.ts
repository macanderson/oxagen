import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// The handler is a thin pass-through to @oxagen/telemetry's fetchSandboxLogs
// (which reads ClickHouse). Mock that one export; spread the rest so any
// transitive telemetry import a sibling module needs still resolves.
const h = vi.hoisted(() => ({
  fetchSandboxLogs: vi.fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    fetchSandboxLogs: h.fetchSandboxLogs,
  };
});

import { agentSandboxLogsListHandler } from "./agent.sandbox_log.list";

const LINE = {
  ts: "2026-07-08 10:00:00.000",
  stream: "stdout" as const,
  level: "normal" as const,
  command: "pnpm build",
  seq: 1,
  line: "built ok",
  exitCode: 0,
  durationMs: 1200,
};

beforeEach(() => {
  h.fetchSandboxLogs.mockReset();
});

describe("agent.sandbox_log.list handler", () => {
  it("passes tenant scope + input through and returns { lines }", async () => {
    h.fetchSandboxLogs.mockResolvedValue([LINE]);

    const out = await agentSandboxLogsListHandler(
      {
        sessionId: "sbx_1",
        level: "normal",
        limit: 200,
        sinceMs: 1_700_000_000_000,
      },
      CTX,
    );

    expect(out).toEqual({ lines: [LINE] });
    expect(h.fetchSandboxLogs).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      sessionId: "sbx_1",
      level: "normal",
      limit: 200,
      sinceMs: 1_700_000_000_000,
    });
  });

  it("forwards an undefined level (all lines) when the debug filter is off", async () => {
    h.fetchSandboxLogs.mockResolvedValue([]);

    const out = await agentSandboxLogsListHandler(
      { sessionId: "sbx_2", limit: 500 },
      CTX,
    );

    expect(out).toEqual({ lines: [] });
    expect(h.fetchSandboxLogs).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      sessionId: "sbx_2",
      level: undefined,
      limit: 500,
      sinceMs: undefined,
    });
  });
});
