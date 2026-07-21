import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Neo4j-backed ontology mutations directly — the adapter is a thin
// translation layer (path -> naturalKey, fail-soft-toward-denial) over them.
const onto = vi.hoisted(() => ({
  acquireFileLock: vi.fn(),
  releaseFileLock: vi.fn(),
  releaseFileLocksByExecution: vi.fn(),
}));
vi.mock("@oxagen/ontology", () => ({
  acquireFileLock: onto.acquireFileLock,
  releaseFileLock: onto.releaseFileLock,
  releaseFileLocksByExecution: onto.releaseFileLocksByExecution,
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("pino", () => ({ default: () => loggerMock }));

import { createFileLockAdapter } from "./file-lock";

describe("createFileLockAdapter", () => {
  beforeEach(() => {
    onto.acquireFileLock.mockReset();
    onto.releaseFileLock.mockReset().mockResolvedValue({ released: true });
    onto.releaseFileLocksByExecution
      .mockReset()
      .mockResolvedValue({ releasedCount: 0 });
    loggerMock.warn.mockClear();
  });

  it("acquire() derives the shared naturalKey format (github:{owner}/{repo}:{path})", async () => {
    onto.acquireFileLock.mockResolvedValue({
      granted: true,
      lockId: "lock-1",
      heldBy: null,
      blockedUntil: null,
    });
    const adapter = createFileLockAdapter({
      owner: "oxageninc",
      repo: "oxagen-platform",
      workspaceId: "ws-1",
    });

    await adapter.acquire({
      path: "src/a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
      action: "write",
    });

    expect(onto.acquireFileLock).toHaveBeenCalledWith({
      naturalKey: "github:oxageninc/oxagen-platform:src/a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
      workspaceId: "ws-1",
      action: "write",
    });
  });

  it("acquire() falls back to the raw path as naturalKey when owner/repo are omitted", async () => {
    onto.acquireFileLock.mockResolvedValue({
      granted: true,
      lockId: "lock-1",
      heldBy: null,
      blockedUntil: null,
    });
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });

    await adapter.acquire({
      path: "src/a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
    });

    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ naturalKey: "src/a.ts" }),
    );
  });

  it("acquire() returns the grant as-is on success", async () => {
    const grant = {
      granted: false,
      lockId: "",
      heldBy: "agent-b",
      blockedUntil: 123,
    };
    onto.acquireFileLock.mockResolvedValue(grant);
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });

    const result = await adapter.acquire({
      path: "a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
    });
    expect(result).toEqual(grant);
  });

  it("acquire() fails SOFT toward denial (never throws) when the Neo4j mutation rejects", async () => {
    onto.acquireFileLock.mockRejectedValue(new Error("neo4j unreachable"));
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });

    const result = await adapter.acquire({
      path: "a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
    });

    expect(result.granted).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "a.ts", agentId: "agent-a" }),
      expect.stringContaining("acquire failed"),
    );
  });

  it("release() delegates to releaseFileLock with lockId + agentId", async () => {
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });
    await adapter.release({ lockId: "lock-1", agentId: "agent-a" });
    expect(onto.releaseFileLock).toHaveBeenCalledWith({
      lockId: "lock-1",
      agentId: "agent-a",
    });
  });

  it("release() is a no-op when lockId is empty (a denied/degraded grant was never held)", async () => {
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });
    await adapter.release({ lockId: "", agentId: "agent-a" });
    expect(onto.releaseFileLock).not.toHaveBeenCalled();
  });

  it("release() never throws when the Neo4j mutation rejects — best-effort, TTL is the backstop", async () => {
    onto.releaseFileLock.mockRejectedValue(new Error("neo4j unreachable"));
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });
    await expect(
      adapter.release({ lockId: "lock-1", agentId: "agent-a" }),
    ).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("releaseAll() delegates to releaseFileLocksByExecution", async () => {
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });
    await adapter.releaseAll("turn-1");
    expect(onto.releaseFileLocksByExecution).toHaveBeenCalledWith({
      executionId: "turn-1",
    });
  });

  it("releaseAll() never throws when the Neo4j mutation rejects", async () => {
    onto.releaseFileLocksByExecution.mockRejectedValue(
      new Error("neo4j unreachable"),
    );
    const adapter = createFileLockAdapter({ workspaceId: "ws-1" });
    await expect(adapter.releaseAll("turn-1")).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
