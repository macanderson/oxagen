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

describe("runCodingAgent – onStepFinish tool-call events (lines 51-58)", () => {
  it("emits a tool-call event for each toolCall reported by onStepFinish", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            // Simulate the AI SDK calling onStepFinish with tool calls.
            args.onStepFinish?.({
              toolCalls: [
                { toolName: "read_file", args: { path: "a.ts" } },
                { toolName: "glob", input: { pattern: "**/*.ts" } },
              ],
            });
            yield { type: "text-delta", text: "finished" };
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
      instruction: "list files",
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("finished");
    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0]).toMatchObject({ type: "tool-call", name: "read_file" });
    expect(toolCallEvents[1]).toMatchObject({ type: "tool-call", name: "glob" });
  });

  it("handles onStepFinish with empty toolCalls array without throwing", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            args.onStepFinish?.({ toolCalls: [] });
            yield { type: "text-delta", text: "ok" };
          })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "noop",
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("ok");
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
  });

  it("handles onStepFinish with undefined toolCalls (null-coalesce path)", async () => {
    const ws = new MemoryWorkspace({});

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            // toolCalls is undefined — exercises the `?? []` branch
            args.onStepFinish?.({ toolCalls: undefined });
            yield { type: "text-delta", text: "ok" };
          })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
    };

    const result = await runCodingAgent({ workspace: ws, ai, instruction: "noop" });
    expect(result.text).toBe("ok");
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
