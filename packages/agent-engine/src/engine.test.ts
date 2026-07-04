import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent, changedFilesFromDiff } from "./engine";
import type { AgentAi, ModelRunArgs, MemoryProvider, TraceStore } from "./ports";
import type { CodingEvent } from "./types";

describe("changedFilesFromDiff", () => {
  it("extracts b/ paths and ignores /dev/null", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n--- a/y.ts\n+++ /dev/null";
    expect(changedFilesFromDiff(diff)).toEqual(["x.ts"]);
  });
});

describe("runCodingAgent", () => {
  it("runs the loop over the injected AgentAi, applies edits, returns a diff", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];

    // The fake AgentAi simulates the model invoking edit_file via a tool call,
    // then emitting text. Injecting it (no vi.mock) is the whole point of the port.
    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            const edit = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await edit.execute({ path: "a.ts", old_string: "foo", new_string: "bar" }, {});
            yield { type: "text-delta", text: "done" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "rename foo to bar",
      model: "anthropic/claude-opus-4-8",
      onEvent: (e) => events.push(e),
    });

    expect(await ws.readFile("a.ts")).toBe("bar");
    expect(result.diff).toContain("a.ts");
    expect(result.changedFiles).toContain("a.ts");
    expect(result.usage.totalTokens).toBe(3);
    expect(result.text).toBe("done");
    expect(events.some((e) => e.type === "final-diff")).toBe(true);
    expect(events.some((e) => e.type === "file-edit")).toBe(true);
  });

  it("injects recalled context into the system prompt and fires memory/trace hooks", async () => {
    const ws = new MemoryWorkspace({ "x.ts": "old" });

    const recallContext = vi.fn().mockResolvedValue("- [constraint] use strict types");
    const remember = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn();

    const memory: MemoryProvider = { recallContext, remember };
    const trace: TraceStore = { record };

    let capturedSystem = "";
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        capturedSystem = args.system;
        capturedMessages = args.messages as Array<{ role: string; content: unknown }>;
        return {
          fullStream: (async function* () {
            const edit = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await edit.execute({ path: "x.ts", old_string: "old", new_string: "new" }, {});
            yield { type: "text-delta", text: "ok" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "update x",
      model: "anthropic/claude-opus-4-8",
      memory,
      trace,
    });

    // Recalled context rides as a volatile user MESSAGE (not in the system
    // prompt), so the system stays a stable, cacheable prefix across turns.
    expect(capturedSystem).not.toContain("Recalled context");
    const recalledMsg = capturedMessages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Recalled context (from prior sessions)"),
    );
    expect(recalledMsg).toBeDefined();
    expect(String(recalledMsg?.content)).toContain("- [constraint] use strict types");

    // Wait a tick for fire-and-forget Promises to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(remember).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledWith(
      "coding_turn",
      expect.objectContaining({ instruction: "update x" }),
    );

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "update x", changedFiles: ["x.ts"] }),
    );
  });

  it("surfaces a memory-recall failure via onError and still completes the turn", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    // The memory store is down: recallContext rejects.
    const recallContext = vi.fn().mockRejectedValue(new Error("neo4j unreachable"));
    const memory: MemoryProvider = { recallContext, remember: vi.fn() };
    const onError = vi.fn();

    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "done" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "do the thing",
      model: "anthropic/claude-opus-4-8",
      memory,
      onError,
    });

    // The recall was attempted, failed loudly through the sink, and the turn
    // still completed (degraded to no recalled context — not killed).
    expect(recallContext).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "memory-recall", error: expect.any(Error) }),
    );
    expect(result.text).toBe("done");
  });
});
