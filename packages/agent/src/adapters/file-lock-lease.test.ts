import { describe, it, expect, vi, beforeEach } from "vitest";

const lease = vi.hoisted(() => ({
  acquireFileLease: vi.fn(),
  releaseFileLease: vi.fn(),
  releaseFileLeasesByExecution: vi.fn(),
}));
vi.mock("../file-lock/lease", () => lease);

import { createFileLeaseLockAdapter } from "./file-lock-lease";

const ADAPTER_ARGS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  owner: "oxageninc",
  repo: "oxagen-platform",
};

describe("createFileLeaseLockAdapter", () => {
  beforeEach(() => {
    lease.acquireFileLease.mockReset();
    lease.releaseFileLease.mockReset().mockResolvedValue({ released: true });
    lease.releaseFileLeasesByExecution
      .mockReset()
      .mockResolvedValue({ released: 0 });
  });

  it("acquires under the SourceFile naturalKey and maps a granted lease (incl. fencing token)", async () => {
    lease.acquireFileLease.mockResolvedValue({
      acquired: [
        { resourceKey: "k", lockId: "lock-9", fencingToken: 4, expiresAt: 99 },
      ],
      conflicts: [],
    });
    const adapter = createFileLeaseLockAdapter(ADAPTER_ARGS);
    const grant = await adapter.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "exec-1",
      action: "write",
    });

    expect(lease.acquireFileLease).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        resourceKeys: ["github:oxageninc/oxagen-platform:src/a.ts"],
        holder: "task-1",
        executionId: "exec-1",
        action: "write",
      }),
    );
    expect(grant).toEqual({
      granted: true,
      lockId: "lock-9",
      heldBy: null,
      blockedUntil: null,
      fencingToken: 4,
    });
  });

  it("maps a conflict to a denial carrying the blocking holder + expiry", async () => {
    lease.acquireFileLease.mockResolvedValue({
      acquired: [],
      conflicts: [{ resourceKey: "k", holder: "task-2", expiresAt: 123 }],
    });
    const grant = await createFileLeaseLockAdapter(ADAPTER_ARGS).acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "exec-1",
      action: "write",
    });
    expect(grant).toEqual({
      granted: false,
      lockId: "",
      heldBy: "task-2",
      blockedUntil: 123,
      fencingToken: null,
    });
  });

  it("fails SOFT (denies) when the lease service throws — a DB outage must never let a write proceed unguarded", async () => {
    lease.acquireFileLease.mockRejectedValue(new Error("db down"));
    const grant = await createFileLeaseLockAdapter(ADAPTER_ARGS).acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "exec-1",
      action: "write",
    });
    expect(grant.granted).toBe(false);
    expect(grant.lockId).toBe("");
  });

  it("release delegates to the holder-guarded releaseFileLease", async () => {
    await createFileLeaseLockAdapter(ADAPTER_ARGS).release({
      lockId: "lock-9",
      agentId: "task-1",
    });
    expect(lease.releaseFileLease).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      lockId: "lock-9",
      holder: "task-1",
    });
  });

  it("release is a no-op for an empty lockId (a denied/degraded grant)", async () => {
    await createFileLeaseLockAdapter(ADAPTER_ARGS).release({
      lockId: "",
      agentId: "task-1",
    });
    expect(lease.releaseFileLease).not.toHaveBeenCalled();
  });

  it("releaseAll batch-releases by executionId", async () => {
    await createFileLeaseLockAdapter(ADAPTER_ARGS).releaseAll("exec-1");
    expect(lease.releaseFileLeasesByExecution).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      executionId: "exec-1",
    });
  });

  it("release/releaseAll swallow lease-service errors (best-effort; TTL is the backstop)", async () => {
    lease.releaseFileLease.mockRejectedValue(new Error("boom"));
    lease.releaseFileLeasesByExecution.mockRejectedValue(new Error("boom"));
    const adapter = createFileLeaseLockAdapter(ADAPTER_ARGS);
    await expect(
      adapter.release({ lockId: "lock-9", agentId: "task-1" }),
    ).resolves.toBeUndefined();
    await expect(adapter.releaseAll("exec-1")).resolves.toBeUndefined();
  });
});
