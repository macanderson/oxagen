/**
 * Additional coverage for runCodingAgent — stream error path (lines 68-69)
 * and onStepFinish tool-call emission (lines 51-58).
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent } from "./engine";
import type { AgentAi, ModelRunArgs } from "./ports";
import type { CodingEvent } from "./types";

describe("runCodingAgent – stream error handling", () => {
  it("re-throws an Error thrown inside fullStream (lines 67-70)", async () => {
    const ws = new MemoryWorkspace({});
    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            throw new Error("stream exploded");
          })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    await expect(
      runCodingAgent({ workspace: ws, ai, instruction: "test" }),
    ).rejects.toThrow("stream exploded");
  });

  it("wraps a non-Error stream failure in an Error", async () => {
    const ws = new MemoryWorkspace({});
    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            throw "raw string failure";
          })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    await expect(
      runCodingAgent({ workspace: ws, ai, instruction: "test" }),
    ).rejects.toThrow("raw string failure");
  });
});

describe("runCodingAgent – tool lifecycle events from stream parts", () => {
  /** Build a fake AgentAi whose fullStream yields the given parts. */
  function aiYielding(parts: unknown[]): AgentAi {
    return {
      stream(_args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            for (const p of parts) yield p;
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };
  }

  it("emits a tool-call event the moment a tool-call part streams in", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
      { type: "tool-call", toolCallId: "c2", toolName: "glob", input: { pattern: "**/*.ts" } },
      { type: "text-delta", text: "finished" },
    ]);

    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "list files",
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("finished");
    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0]).toMatchObject({ type: "tool-call", name: "read_file" });
    expect(toolCallEvents[1]).toMatchObject({ type: "tool-call", name: "glob" });
  });

  it("emits a tool-result event with ok flag and per-tool duration when the result part arrives", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "pytest" } },
      { type: "tool-result", toolCallId: "c1", toolName: "bash", input: { command: "pytest" }, output: "3 passed" },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({ workspace: ws, ai, instruction: "run tests", onEvent: (e) => events.push(e) });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool-result", name: "bash", ok: true });
    expect((results[0] as { result: string }).result).toContain("3 passed");
    expect((results[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips preliminary tool-result parts (only the final result emits an event)", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
      { type: "tool-result", toolCallId: "c1", toolName: "bash", input: { command: "ls" }, output: "partial", preliminary: true },
      { type: "tool-result", toolCallId: "c1", toolName: "bash", input: { command: "ls" }, output: "full" },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({ workspace: ws, ai, instruction: "ls", onEvent: (e) => events.push(e) });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect((results[0] as { result: string }).result).toContain("full");
  });

  it("maps a tool-error part to an ok:false tool-result event", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      { type: "tool-call", toolCallId: "c1", toolName: "edit_file", input: { path: "x" } },
      { type: "tool-error", toolCallId: "c1", toolName: "edit_file", input: { path: "x" }, error: new Error("String not found") },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({ workspace: ws, ai, instruction: "edit", onEvent: (e) => events.push(e) });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool-result", name: "edit_file", ok: false });
  });

  it("handles a stream with no tool parts without emitting tool events", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([{ type: "text-delta", text: "ok" }]);

    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "noop",
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("ok");
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(0);
  });
});

describe("runCodingAgent – default model and system", () => {
  it("uses default model and system when not provided", async () => {
    const ws = new MemoryWorkspace({});
    const observed: { model: string; system: string }[] = [];

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        observed.push({ model: args.model, system: args.system });
        return {
          fullStream: (async function* () { yield { type: "text-delta", text: "" }; })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    await runCodingAgent({ workspace: ws, ai, instruction: "go" });
    expect(observed[0]!.model).toBe("anthropic/claude-opus-4-8");
    expect(observed[0]!.system).toContain("expert software engineer");
  });
});
