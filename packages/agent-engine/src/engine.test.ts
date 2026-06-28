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
          textStream: (async function* () {
            const edit = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await edit.execute({ path: "a.ts", old_string: "foo", new_string: "bar" }, {});
            yield "done";
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

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        capturedSystem = args.system;
        return {
          textStream: (async function* () {
            const edit = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await edit.execute({ path: "x.ts", old_string: "old", new_string: "new" }, {});
            yield "ok";
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

    // Recalled context must be in the system prompt passed to the model
    expect(capturedSystem).toContain("- [constraint] use strict types");
    expect(capturedSystem).toContain("Recalled context (from prior sessions)");

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
});
