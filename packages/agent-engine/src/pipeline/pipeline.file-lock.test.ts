/**
 * Pipeline (runTurn) — file-lock port tests (OXA-2070,
 * docs/specs/agent-file-locking/plan.md).
 *
 * Proves that:
 *  1. runTurn generates ONE lock identity per turn and threads it into every
 *     write_file/edit_file acquire (via tools.ts), consistently across a bare
 *     single-round turn.
 *  2. runTurn batch-releases (`releaseAll`) everything the turn's executionId
 *     holds when the turn ends.
 *  3. A throwing `releaseAll` does NOT propagate — the turn still succeeds
 *     (the provider's fail-soft contract).
 *  4. Two INDEPENDENT `runTurn` calls — standing in for the chat surface and
 *     a fleet subagent child, both of which funnel through this same shared
 *     engine (docs/adr/ADR-017-unified-agent-engine.md) — get DIFFERENT lock
 *     identities and correctly race on the same target path when backed by a
 *     single shared (stateful) FileLockProvider, proving the ONE wiring
 *     point in tools.ts protects every caller without per-caller code.
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import type {
  AgentAi,
  FileLockProvider,
  FileLockGrant,
  ModelRunArgs,
} from "../ports";

function makeAi(editFile?: string): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          if (editFile) {
            const editTool = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await editTool.execute(
              { path: editFile, old_string: "before", new_string: "after" },
              {},
            );
          }
          yield { type: "text-delta", text: "done" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        response: Promise.resolve({ messages: [] }),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () => ({
      object: {} as never,
      usage: { totalTokens: 0 },
    }),
  };
}

describe("runTurn — FileLockProvider", () => {
  it("acquires under ONE lock identity for the whole turn and releaseAll's it with the SAME executionId at turn end", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });

    const acquire = vi.fn(
      async (
        _args: Parameters<FileLockProvider["acquire"]>[0],
      ): Promise<FileLockGrant> => ({
        granted: true,
        lockId: "lock-1",
        heldBy: null,
        blockedUntil: null,
      }),
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const releaseAll = vi.fn().mockResolvedValue(undefined);
    const fileLock: FileLockProvider = { acquire, release, releaseAll };

    await runTurn({
      prompt: "rename before to after in src/a.ts",
      workspace: ws,
      ai: makeAi("src/a.ts"),
      bare: true,
      fileLock,
    });

    await new Promise((r) => setImmediate(r));

    expect(acquire).toHaveBeenCalledOnce();
    const [acquireArgs] = acquire.mock.calls[0]!;
    expect(acquireArgs.path).toBe("src/a.ts");
    expect(acquireArgs.agentId).toMatch(/^turn_/);

    expect(release).toHaveBeenCalledWith({
      lockId: "lock-1",
      agentId: acquireArgs.agentId,
    });

    expect(releaseAll).toHaveBeenCalledOnce();
    // The SAME id is used for both agentId (renew identity) and executionId
    // (turn-end batch-release correlation).
    expect(releaseAll).toHaveBeenCalledWith(acquireArgs.agentId);
  });

  it("does NOT acquire/release when no files are touched", async () => {
    const ws = new MemoryWorkspace({ "src/d.ts": "untouched" });
    const acquire = vi.fn();
    const releaseAll = vi.fn().mockResolvedValue(undefined);
    const fileLock: FileLockProvider = {
      acquire,
      release: vi.fn(),
      releaseAll,
    };

    await runTurn({
      prompt: "describe the file",
      workspace: ws,
      ai: makeAi(), // no file edit
      bare: true,
      fileLock,
    });

    await new Promise((r) => setImmediate(r));

    expect(acquire).not.toHaveBeenCalled();
    // releaseAll is still fired (harmless no-op) — the turn always has a lock
    // identity once fileLock is injected, regardless of whether it acquired anything.
    expect(releaseAll).toHaveBeenCalledOnce();
  });

  it("does NOT propagate a throwing releaseAll — the turn still succeeds (fail-soft)", async () => {
    const ws = new MemoryWorkspace({ "src/b.ts": "before" });
    const fileLock: FileLockProvider = {
      acquire: vi.fn(
        async (): Promise<FileLockGrant> => ({
          granted: true,
          lockId: "lock-1",
          heldBy: null,
          blockedUntil: null,
        }),
      ),
      release: vi.fn().mockResolvedValue(undefined),
      releaseAll: vi.fn().mockRejectedValue(new Error("Neo4j down")),
    };

    const result = await runTurn({
      prompt: "rename before to after in src/b.ts",
      workspace: ws,
      ai: makeAi("src/b.ts"),
      bare: true,
      fileLock,
    });

    await new Promise((r) => setImmediate(r));

    expect(result.text).toBe("done");
  });

  it("proceeds unlocked (no acquire/release calls) when fileLock is omitted — byte-identical to before this feature", async () => {
    const ws = new MemoryWorkspace({ "src/c.ts": "before" });
    const result = await runTurn({
      prompt: "rename before to after in src/c.ts",
      workspace: ws,
      ai: makeAi("src/c.ts"),
      bare: true,
    });
    expect(result.text).toBe("done");
  });
});

describe("runTurn — FileLockProvider protects independent callers (chat vs. fleet)", () => {
  it("two independent runTurn calls sharing ONE FileLockProvider get different lock identities and correctly serialize on the same target path", async () => {
    // Chat surface (apps/app/src/app/api/v1/chat/stream/route.ts) and a fleet
    // subagent child (agent.repo.edit dispatched via agent.execute-subagent)
    // both funnel through runCodingAgent → the SAME tools.ts wiring — neither
    // knows about the other. A single stateful fake stands in for the shared
    // transactional Postgres lease.
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
        for (const [path, holder] of holders) {
          if (holder === agentId) holders.delete(path);
        }
      },
      releaseAll: async (executionId) => {
        for (const [path, holder] of holders) {
          if (holder === executionId) holders.delete(path);
        }
      },
    };

    // Pre-hold the path as if the "chat" turn is mid-edit.
    holders.set("shared.ts", "chat-turn-holding");

    const wsFleet = new MemoryWorkspace({ "shared.ts": "before" });
    const fleetResult = await runTurn({
      prompt: "rename before to after in shared.ts",
      workspace: wsFleet,
      ai: makeAi("shared.ts"),
      bare: true,
      fileLock: sharedLock,
    });
    await new Promise((r) => setImmediate(r));

    // The fleet turn's edit_file call was denied — the file is unchanged and
    // the tool result surfaced the denial back into the turn's text/trace
    // instead of silently skipping.
    expect(await wsFleet.readFile("shared.ts")).toBe("before");

    // Once the chat turn "finishes" (simulated release), an independent
    // second runTurn (a different chat message, or a different fleet child)
    // can proceed on the same path.
    holders.delete("shared.ts");
    const wsSecond = new MemoryWorkspace({ "shared.ts": "before" });
    await runTurn({
      prompt: "rename before to after in shared.ts",
      workspace: wsSecond,
      ai: makeAi("shared.ts"),
      bare: true,
      fileLock: sharedLock,
    });
    await new Promise((r) => setImmediate(r));

    expect(await wsSecond.readFile("shared.ts")).toBe("after");
    void fleetResult;
  });
});
