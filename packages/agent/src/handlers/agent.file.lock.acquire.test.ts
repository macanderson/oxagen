import { describe, it, expect, vi, beforeEach } from "vitest";

const onto = vi.hoisted(() => ({ acquireFileLock: vi.fn() }));
vi.mock("@oxagen/ontology", () => ({ acquireFileLock: onto.acquireFileLock }));

import { agentFileLockAcquireHandler } from "./agent.file.lock.acquire";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

describe("agentFileLockAcquireHandler", () => {
  beforeEach(() => {
    onto.acquireFileLock.mockReset().mockResolvedValue({
      granted: true,
      lockId: "lock-1",
      heldBy: null,
      blockedUntil: null,
    });
  });

  it("derives the naturalKey from path + owner + repo (matching write_file/edit_file's own lock key)", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", owner: "oxageninc", repo: "oxagen-platform" },
      TEST_CTX,
    );
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ naturalKey: "github:oxageninc/oxagen-platform:src/a.ts" }),
    );
  });

  it("falls back to the raw path when owner/repo are omitted", async () => {
    await agentFileLockAcquireHandler({ path: "src/a.ts" }, TEST_CTX);
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ naturalKey: "src/a.ts" }),
    );
  });

  it("defaults agentId to ctx.userId when the caller doesn't supply one", async () => {
    await agentFileLockAcquireHandler({ path: "src/a.ts" }, makeCTX({ userId: "u_42" }));
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "u_42" }),
    );
  });

  it("falls back to ctx.apiKeyId when userId is null", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts" },
      makeCTX({ userId: null, apiKeyId: "key_1" }),
    );
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "key_1" }),
    );
  });

  it("honours a caller-supplied agentId/executionId", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", agentId: "agent-x", executionId: "turn-x" },
      TEST_CTX,
    );
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-x", executionId: "turn-x" }),
    );
  });

  it("passes workspaceId from ctx and forwards action/ttlMs", async () => {
    await agentFileLockAcquireHandler(
      { path: "src/a.ts", action: "read", ttlMs: 10_000 },
      makeCTX({ workspaceId: "ws_9" }),
    );
    expect(onto.acquireFileLock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_9", action: "read", ttlMs: 10_000 }),
    );
  });

  it("returns the mutation's result as-is", async () => {
    const grant = { granted: false, lockId: "", heldBy: "agent-b", blockedUntil: 123 };
    onto.acquireFileLock.mockResolvedValue(grant);
    const result = await agentFileLockAcquireHandler({ path: "src/a.ts" }, TEST_CTX);
    expect(result).toEqual(grant);
  });
});
