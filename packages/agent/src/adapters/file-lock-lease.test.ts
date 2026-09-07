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

  /**
   * #1358's definition of done: "a two-turn race test where the second turn
   * spells the path differently and is still denied."
   *
   * It belongs here rather than in `agent-engine`'s `tools.file-lock.test.ts`.
   * `tools.ts` hands `acquire` the path exactly as the model spelled it, and
   * this adapter is the one place `toFileResourceKey` turns that spelling into
   * the lease's notion of identity — so this is the layer where two spellings
   * either do or do not exclude each other. The engine-level race test keys its
   * fake on the raw path, which is why it passes with or without the fix.
   *
   * `resource-key.test.ts` proves the two spellings produce one key. That is
   * the mechanism; this is the outcome the lock exists for, and the issue asks
   * for the outcome: two lease keys means both agents are granted, both write,
   * and the last writer wins silently.
   */
  describe("two turns racing on one file spelled two ways (#1358)", () => {
    /** A lease store with real mutual exclusion, keyed the way Postgres is. */
    function statefulLeaseStore() {
      const held = new Map<string, string>();
      let nextLockId = 0;
      lease.acquireFileLease.mockImplementation(
        async ({
          resourceKeys,
          holder,
        }: {
          resourceKeys: string[];
          holder: string;
        }) => {
          const acquired = [];
          const conflicts = [];
          for (const resourceKey of resourceKeys) {
            const current = held.get(resourceKey);
            if (current !== undefined && current !== holder) {
              conflicts.push({
                resourceKey,
                holder: current,
                expiresAt: 60_000,
              });
              continue;
            }
            held.set(resourceKey, holder);
            acquired.push({
              resourceKey,
              lockId: `lock-${++nextLockId}`,
              fencingToken: nextLockId,
              expiresAt: 60_000,
            });
          }
          return { acquired, conflicts };
        },
      );
      return held;
    }

    it.each([
      ["./src/foo.ts", "a leading dot"],
      ["src/../src/foo.ts", "a round trip through the parent"],
      ["src//foo.ts", "a duplicate separator"],
      ["/src/foo.ts", "a leading separator"],
      ["./src/./foo.ts", "an interior dot"],
    ])(
      "denies turn B spelling the held file %s (%s)",
      async (spelling: string) => {
        statefulLeaseStore();
        const adapter = createFileLeaseLockAdapter(ADAPTER_ARGS);

        const first = await adapter.acquire({
          path: "src/foo.ts",
          agentId: "turn-a",
          executionId: "exec-a",
          action: "write",
        });
        expect(first.granted).toBe(true);

        const second = await adapter.acquire({
          path: spelling,
          agentId: "turn-b",
          executionId: "exec-b",
          action: "write",
        });

        // Before canonicalization this returned granted:true — a second key is
        // a second resource, so both turns wrote and the last one won.
        expect(second.granted).toBe(false);
        expect(second.heldBy).toBe("turn-a");
      },
    );

    it("still grants turn B a genuinely different file", async () => {
      // The negative control: over-collapsing would deny this and make the
      // suite above pass for the wrong reason.
      statefulLeaseStore();
      const adapter = createFileLeaseLockAdapter(ADAPTER_ARGS);

      await adapter.acquire({
        path: "src/foo.ts",
        agentId: "turn-a",
        executionId: "exec-a",
        action: "write",
      });
      const second = await adapter.acquire({
        path: "./src/bar.ts",
        agentId: "turn-b",
        executionId: "exec-b",
        action: "write",
      });

      expect(second.granted).toBe(true);
    });

    it("excludes on the unscoped branch too, which used to pass the path through verbatim", async () => {
      statefulLeaseStore();
      const adapter = createFileLeaseLockAdapter({
        orgId: "org-1",
        workspaceId: "ws-1",
      });

      const first = await adapter.acquire({
        path: "src/foo.ts",
        agentId: "turn-a",
        executionId: "exec-a",
        action: "write",
      });
      expect(first.granted).toBe(true);

      const second = await adapter.acquire({
        path: "./src/foo.ts",
        agentId: "turn-b",
        executionId: "exec-b",
        action: "write",
      });
      expect(second.granted).toBe(false);
      expect(second.heldBy).toBe("turn-a");
    });
  });
});
