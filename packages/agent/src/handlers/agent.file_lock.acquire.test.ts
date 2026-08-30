import { describe, it, expect, vi, beforeEach } from "vitest";

const lease = vi.hoisted(() => ({ acquireFileLease: vi.fn() }));
vi.mock("../file-lock/lease", () => ({
  acquireFileLease: lease.acquireFileLease,
}));

import { agentFileLockAcquireHandler } from "./agent.file_lock.acquire";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

function granted(overrides: Record<string, unknown> = {}) {
  return {
    acquired: [
      {
        resourceKey: "src/a.ts",
        lockId: "lock-1",
        fencingToken: 1,
        expiresAt: 2,
        ...overrides,
      },
    ],
    conflicts: [],
  };
}

describe("agentFileLockAcquireHandler", () => {
  beforeEach(() => {
    lease.acquireFileLease.mockReset().mockResolvedValue(granted());
  });

  it("derives the resourceKey from path + owner + repo (matching write_file/edit_file's own lock key)", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", owner: "oxageninc", repo: "oxagen-platform" },
      TEST_CTX,
    );
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKeys: ["github:oxageninc/oxagen-platform:src/a.ts"],
      }),
    );
  });

  it("falls back to the raw path when owner/repo are omitted", async () => {
    await agentFileLockAcquireHandler({ path: "src/a.ts" }, TEST_CTX);
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({ resourceKeys: ["src/a.ts"] }),
    );
  });

  it("defaults the holder to ctx.userId when the caller doesn't supply an agentId", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts" },
      makeCTX({ userId: "u_42" }),
    );
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({ holder: "u_42" }),
    );
  });

  it("falls back to ctx.apiKeyId when userId is null", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts" },
      makeCTX({ userId: null, apiKeyId: "key_1" }),
    );
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({ holder: "key_1" }),
    );
  });

  it("honours a caller-supplied agentId/executionId", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", agentId: "agent-x", executionId: "turn-x" },
      TEST_CTX,
    );
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({ holder: "agent-x", executionId: "turn-x" }),
    );
  });

  it("passes org/workspace from ctx and forwards action/ttlMs", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", action: "read", ttlMs: 10_000 },
      makeCTX({ orgId: "org_9", workspaceId: "ws_9" }),
    );
    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_9",
        workspaceId: "ws_9",
        action: "read",
        ttlMs: 10_000,
      }),
    );
  });

  it("maps a granted lease to the contract output, including the fencing token", async () => {
    lease.acquireFileLease.mockResolvedValue(
      granted({ lockId: "lock-9", fencingToken: 7, expiresAt: 999 }),
    );
    const result = await agentFileLockAcquireHandler(
      { path: "src/a.ts" },
      TEST_CTX,
    );
    expect(result).toEqual({
      granted: true,
      lockId: "lock-9",
      heldBy: null,
      blockedUntil: null,
      fencingToken: 7,
    });
  });

  it("maps a conflict to granted:false with the blocking holder + expiry", async () => {
    lease.acquireFileLease.mockResolvedValue({
      acquired: [],
      conflicts: [
        { resourceKey: "src/a.ts", holder: "agent-b", expiresAt: 123 },
      ],
    });
    const result = await agentFileLockAcquireHandler(
      { path: "src/a.ts" },
      TEST_CTX,
    );
    expect(result).toEqual({
      granted: false,
      lockId: "",
      heldBy: "agent-b",
      blockedUntil: 123,
      fencingToken: null,
    });
  });
});
