import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalFileLockProvider } from "../fleet/local-file-lock.js";

/**
 * LocalFileLockProvider (ADR-021 §5) — the CLI fleet's on-machine file lock.
 * A controllable clock drives TTL expiry deterministically (no sleeps).
 */
describe("createLocalFileLockProvider", () => {
  let root: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oxagen-locks-"));
    clock = 1_000_000;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function provider(ttlMs = 300_000) {
    return createLocalFileLockProvider({ root, ttlMs, now });
  }

  it("grants a lock and returns a positive fencing token", async () => {
    const p = provider();
    const grant = await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    expect(grant.granted).toBe(true);
    expect(grant.lockId).not.toBe("");
    expect(grant.fencingToken).toBe(1);
  });

  it("blocks a DIFFERENT holder while the lock is live, reporting the holder + expiry", async () => {
    const p = provider();
    await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    const denied = await p.acquire({
      path: "src/a.ts",
      agentId: "task-2",
      executionId: "task-2",
      action: "write",
    });
    expect(denied.granted).toBe(false);
    expect(denied.heldBy).toBe("task-1");
    expect(denied.blockedUntil).toBe(1_000_000 + 300_000);
    expect(denied.fencingToken).toBeNull();
  });

  it("lets the SAME holder renew (reusing its lockId)", async () => {
    const p = provider();
    const a = await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    const b = await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    expect(b.granted).toBe(true);
    expect(b.lockId).toBe(a.lockId);
  });

  it("frees the lock on release so another holder can take it", async () => {
    const p = provider();
    const a = await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    p.release({ lockId: a.lockId, agentId: "task-1" });
    const b = await p.acquire({
      path: "src/a.ts",
      agentId: "task-2",
      executionId: "task-2",
      action: "write",
    });
    expect(b.granted).toBe(true);
  });

  it("releaseAll frees every lock an execution holds", async () => {
    const p = provider();
    await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "exec-1",
      action: "write",
    });
    await p.acquire({
      path: "src/b.ts",
      agentId: "task-1",
      executionId: "exec-1",
      action: "write",
    });
    p.releaseAll("exec-1");
    const a = await p.acquire({
      path: "src/a.ts",
      agentId: "task-2",
      executionId: "exec-2",
      action: "write",
    });
    const b = await p.acquire({
      path: "src/b.ts",
      agentId: "task-2",
      executionId: "exec-2",
      action: "write",
    });
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
  });

  it("takes over an EXPIRED lock and issues a strictly higher fencing token", async () => {
    const p = provider(1_000);
    const first = await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    expect(first.fencingToken).toBe(1);
    // Advance past the lease window — the old holder's lease is now stale.
    clock += 2_000;
    const second = await p.acquire({
      path: "src/a.ts",
      agentId: "task-2",
      executionId: "task-2",
      action: "write",
    });
    expect(second.granted).toBe(true);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken as number);
  });

  it("writes an on-disk lock file so a second process sees the lock", async () => {
    const p = provider();
    await p.acquire({
      path: "src/a.ts",
      agentId: "task-1",
      executionId: "task-1",
      action: "write",
    });
    const locksDir = join(root, ".oxagen", "locks");
    expect(existsSync(locksDir)).toBe(true);
    expect(readdirSync(locksDir).some((f) => f.endsWith(".lock"))).toBe(true);
  });

  it("blocks a second in-process provider (cross-process guard) via the lock file", async () => {
    const p1 = provider();
    const p2 = provider();
    await p1.acquire({
      path: "src/a.ts",
      agentId: "proc-1",
      executionId: "proc-1",
      action: "write",
    });
    const denied = await p2.acquire({
      path: "src/a.ts",
      agentId: "proc-2",
      executionId: "proc-2",
      action: "write",
    });
    expect(denied.granted).toBe(false);
    expect(denied.heldBy).toBe("proc-1");
  });
});
