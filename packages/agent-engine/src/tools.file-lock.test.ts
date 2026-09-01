/**
 * Coverage for the agent-file-locking wiring (OXA-2070,
 * docs/specs/agent-file-locking/plan.md) — the SINGLE enforcement point:
 * write_file/edit_file acquire before the real filesystem write and release
 * after, for every surface that runs a turn (chat, CLI, agent.repo.edit fleet
 * dispatch) alike. `FileLockProvider` is faked here; the real Neo4j-backed
 * acquire/release Cypher is covered by
 * packages/ontology/src/mutations/acquire-file-lock.test.ts,
 * release-file-lock.test.ts, and the integration test.
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import type { FileLockProvider, FileLockGrant } from "./ports";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

function grantedLock(lockId = "lock-1"): FileLockGrant {
  return { granted: true, lockId, heldBy: null, blockedUntil: null };
}

function deniedLock(heldBy: string, blockedUntil: number): FileLockGrant {
  return { granted: false, lockId: "", heldBy, blockedUntil };
}

function fakeFileLock(overrides: Partial<FileLockProvider> = {}): {
  provider: FileLockProvider;
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const acquire = vi.fn(overrides.acquire ?? (async () => grantedLock()));
  const release = vi.fn(overrides.release ?? (async () => undefined));
  return {
    provider: { acquire, release, releaseAll: vi.fn() },
    acquire,
    release,
  };
}

describe("buildWorkspaceTools — agent file locking (write_file)", () => {
  it("proceeds unlocked when no fileLock is injected (CLI default — byte-identical to before this feature)", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });
    expect(result).toContain("Wrote 5 bytes");
    expect(await ws.readFile("a.ts")).toBe("hello");
  });

  it("acquires the lock for lockContext.agentId/executionId before writing, and releases it after", async () => {
    const { provider, acquire, release } = fakeFileLock();
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });

    expect(result).toContain("Wrote 5 bytes");
    expect(await ws.readFile("a.ts")).toBe("hello");
    expect(acquire).toHaveBeenCalledWith({
      path: "a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
      action: "write",
    });
    expect(release).toHaveBeenCalledWith({
      lockId: "lock-1",
      agentId: "agent-a",
    });
  });

  it("does NOT perform the write when every acquire attempt is denied — returns a clear denial instead of silently skipping", async () => {
    const { provider, acquire } = fakeFileLock({
      acquire: async () => deniedLock("agent-b", Date.now() + 60_000),
    });
    const ws = new MemoryWorkspace({ "a.ts": "original" });
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });

    expect(result).toContain("Blocked");
    expect(result).toContain("a.ts");
    expect(result).toContain("agent-b");
    // The write must NOT have happened — the file is unchanged.
    expect(await ws.readFile("a.ts")).toBe("original");
    // Exhausts exactly the bounded retry budget (FILE_LOCK_ACQUIRE_ATTEMPTS = 3),
    // never spins unbounded — a regression that changed the budget fails here.
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it("retries a denied acquire up to the bounded budget and succeeds if a later attempt is granted", async () => {
    let calls = 0;
    const { provider, acquire } = fakeFileLock({
      acquire: async () => {
        calls++;
        return calls < 2
          ? deniedLock("agent-b", Date.now() + 1_000)
          : grantedLock("lock-2");
      },
    });
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });

    expect(result).toContain("Wrote 5 bytes");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await ws.readFile("a.ts")).toBe("hello");
  });

  it("releases the lock even when the underlying write throws", async () => {
    const { provider, release } = fakeFileLock();
    const ws = new MemoryWorkspace({});
    // editFile on a nonexistent file throws ENOENT inside the workspace.
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.edit_file, {
      path: "missing.ts",
      old_string: "x",
      new_string: "y",
    });

    expect(result).toContain("Error editing missing.ts");
    expect(release).toHaveBeenCalledWith({
      lockId: "lock-1",
      agentId: "agent-a",
    });
  });

  it("a release failure never surfaces to the tool result (best-effort; TTL/backstop covers it)", async () => {
    const { provider } = fakeFileLock({
      release: async () => {
        throw new Error("neo4j down");
      },
    });
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });
    expect(result).toContain("Wrote 5 bytes");
  });

  it("an aborted turn breaks out of the acquire retry loop after the first denial and denies the write (no full-budget wait)", async () => {
    // First attempt is denied; the retry then hits `delay(..., signal)`, which
    // rejects immediately because the signal is already aborted — the loop's
    // `catch { break; }` fires, falling through to the denial path WITHOUT a
    // second acquire and WITHOUT performing the write. This exercises the
    // abort-mid-retry break branch deterministically (only ONE acquire, not 3).
    const controller = new AbortController();
    controller.abort();
    const { provider, acquire } = fakeFileLock({
      acquire: async () => deniedLock("agent-b", Date.now() + 60_000),
    });
    const ws = new MemoryWorkspace({ "a.ts": "original" });
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
      signal: controller.signal,
    });

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "hello",
    });

    expect(result).toContain("Blocked");
    expect(await ws.readFile("a.ts")).toBe("original");
    // Broke out after the FIRST denial instead of exhausting all 3 attempts.
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});

describe("buildWorkspaceTools — agent file locking (edit_file)", () => {
  it("acquires before an edit and releases after", async () => {
    const { provider, acquire, release } = fakeFileLock();
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws, {
      fileLock: provider,
      lockContext: { agentId: "agent-a", executionId: "turn-1" },
    });

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });

    expect(result).toContain("Edited /repo/a.ts");
    expect(await ws.readFile("a.ts")).toBe("const x = 2;");
    expect(acquire).toHaveBeenCalledWith({
      path: "a.ts",
      agentId: "agent-a",
      executionId: "turn-1",
      action: "write",
    });
    expect(release).toHaveBeenCalledWith({
      lockId: "lock-1",
      agentId: "agent-a",
    });
  });

  it("two concurrent turns racing on the SAME path: the second sees a denial while the first still holds it", async () => {
    // Simulates two concurrent turns (e.g. the chat surface and a fleet
    // subagent, both funneling through the same shared engine per
    // docs/adr/ADR-017-unified-agent-engine.md) targeting the same file. A
    // single shared, stateful fake stands in for the real transactional
    // Postgres lease's mutual exclusion.
    const holders = new Map<string, string>();
    const sharedLock: FileLockProvider = {
      acquire: async ({ path, agentId }) => {
        const holder = holders.get(path);
        if (holder && holder !== agentId) {
          return {
            granted: false,
            lockId: "",
            heldBy: holder,
            blockedUntil: Date.now() + 60_000,
          };
        }
        holders.set(path, agentId);
        return {
          granted: true,
          lockId: `lock-${agentId}`,
          heldBy: null,
          blockedUntil: null,
        };
      },
      release: async ({ agentId }) => {
        // Only clear the holder if this agent is the one holding it — an
        // agent can only release its own lock, mirroring the graph mutation.
        for (const [path, holder] of holders) {
          if (holder === agentId) holders.delete(path);
        }
      },
      releaseAll: vi.fn(),
    };

    const wsChat = new MemoryWorkspace({});
    const wsFleet = new MemoryWorkspace({});
    const chatTools = buildWorkspaceTools(wsChat, {
      fileLock: sharedLock,
      lockContext: { agentId: "chat-turn", executionId: "chat-turn" },
    });
    const fleetTools = buildWorkspaceTools(wsFleet, {
      fileLock: sharedLock,
      lockContext: { agentId: "fleet-child-1", executionId: "fleet-child-1" },
    });

    // Hold the lock via the chat path first (acquire without releasing yet by
    // never resolving the write) — simulate by acquiring directly. Non-code
    // (.txt) paths keep this focused on the LOCK: the marker content is not
    // valid code and the syntax gate (correctly) only applies to code files.
    holders.set("shared.txt", "chat-turn");

    const fleetResult = await run(fleetTools.write_file, {
      path: "shared.txt",
      content: "from fleet",
    });
    expect(fleetResult).toContain("Blocked");
    expect(fleetResult).toContain("chat-turn");

    // Once the chat turn releases (simulated), the fleet child can proceed.
    holders.delete("shared.txt");
    const fleetRetry = await run(fleetTools.write_file, {
      path: "shared.txt",
      content: "from fleet",
    });
    expect(fleetRetry).toContain("Wrote");
    expect(await wsFleet.readFile("shared.txt")).toBe("from fleet");

    // Sanity: chatTools' own write to a DIFFERENT path is unaffected.
    const chatResult = await run(chatTools.write_file, {
      path: "chat-only.txt",
      content: "from chat",
    });
    expect(chatResult).toContain("Wrote");
  });
});
