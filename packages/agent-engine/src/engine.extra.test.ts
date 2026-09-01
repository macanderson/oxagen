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
          usage: Promise.resolve({
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
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
          usage: Promise.resolve({
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
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

  it("emits a tool-call event the moment a tool-call part streams in", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "read_file",
        input: { path: "a.ts" },
      },
      {
        type: "tool-call",
        toolCallId: "c2",
        toolName: "search",
        input: { query: ".ts" },
      },
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
    expect(toolCallEvents[0]).toMatchObject({
      type: "tool-call",
      name: "read_file",
    });
    expect(toolCallEvents[1]).toMatchObject({
      type: "tool-call",
      name: "search",
    });
  });

  it("emits a tool-result event with ok flag and per-tool duration when the result part arrives", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "pytest" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "pytest" },
        output: "3 passed",
      },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "run tests",
      onEvent: (e) => events.push(e),
    });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "tool-result",
      name: "bash",
      ok: true,
    });
    expect((results[0] as { result: string }).result).toContain("3 passed");
    expect(
      (results[0] as { durationMs: number }).durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("skips preliminary tool-result parts (only the final result emits an event)", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "ls" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "ls" },
        output: "partial",
        preliminary: true,
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "ls" },
        output: "full",
      },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "ls",
      onEvent: (e) => events.push(e),
    });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect((results[0] as { result: string }).result).toContain("full");
  });

  it("maps a tool-error part to an ok:false tool-result event", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "edit_file",
        input: { path: "x" },
      },
      {
        type: "tool-error",
        toolCallId: "c1",
        toolName: "edit_file",
        input: { path: "x" },
        error: new Error("String not found"),
      },
      { type: "text-delta", text: "ok" },
    ]);

    await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "edit",
      onEvent: (e) => events.push(e),
    });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "tool-result",
      name: "edit_file",
      ok: false,
    });
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
          fullStream: (async function* () {
            yield { type: "text-delta", text: "" };
          })(),
          steps: Promise.resolve([]),
          usage: Promise.resolve({
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };

    await runCodingAgent({ workspace: ws, ai, instruction: "go" });
    expect(observed[0]!.model).toBe("anthropic/claude-fable-5");
    expect(observed[0]!.system).toContain("expert software engineer");
  });
});

describe("runCodingAgent – explicit step loop (multi-step, retry, compaction)", () => {
  type Part = Record<string, unknown>;
  /** A scriptable AgentAi: `scripts[i]` drives the i-th stream() call. */
  function scriptedAi(
    scripts: Array<{
      parts?: Part[];
      throwError?: unknown; // thrown from inside fullStream on this call
      finishReason?: string; // default inferred: "tool-calls" if a tool-call part present else "stop"
    }>,
  ): { ai: AgentAi; calls: () => number } {
    let call = 0;
    const ai: AgentAi = {
      stream(_args: ModelRunArgs) {
        const script = scripts[Math.min(call, scripts.length - 1)]!;
        call++;
        const hasToolCall = (script.parts ?? []).some(
          (p) => p["type"] === "tool-call",
        );
        const finishReason =
          script.finishReason ?? (hasToolCall ? "tool-calls" : "stop");
        return {
          fullStream: (async function* () {
            for (const p of script.parts ?? []) yield p;
            if (script.throwError) throw script.throwError;
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({
            messages: [{ role: "assistant", content: "" }],
          }),
          finishReason: Promise.resolve(finishReason),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };
    return { ai, calls: () => call };
  }

  it("continues to the next step while finishReason is tool-calls, stops on stop", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    const { ai, calls } = scriptedAi([
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "a.ts" },
          },
        ],
      }, // → tool-calls, loop
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "search",
            input: { query: "x" },
          },
        ],
      }, // → tool-calls, loop
      { parts: [{ type: "text-delta", text: "all done" }] }, // → stop
    ]);
    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "go",
    });
    expect(calls()).toBe(3);
    expect(result.text).toBe("all done");
    expect(result.steps).toBe(3);
    // usage accumulated across the 3 steps (2 tokens each).
    expect(result.usage.totalTokens).toBe(6);
  });

  it("retries a transient stream error on the SAME step, then succeeds without double-counting text", async () => {
    const ws = new MemoryWorkspace({});
    const overloaded = new Error("service unavailable (503) — overloaded");
    const { ai, calls } = scriptedAi([
      {
        parts: [{ type: "text-delta", text: "partial" }],
        throwError: overloaded,
      }, // step fails after emitting
      { parts: [{ type: "text-delta", text: "final answer" }] }, // retry succeeds
    ]);
    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "go",
    });
    expect(calls()).toBe(2);
    // Only the SUCCESSFUL step's text is committed — the failed attempt's
    // "partial" delta is not double-counted into the return text.
    expect(result.text).toBe("final answer");
    expect(result.steps).toBe(1);
  });

  it("gives up after the retry budget is exhausted and throws", async () => {
    const ws = new MemoryWorkspace({});
    const err = new Error("429 rate limit");
    const { ai } = scriptedAi([{ throwError: err }]); // every call throws (script repeats last)
    await expect(
      runCodingAgent({ workspace: ws, ai, instruction: "go", maxRetries: 2 }),
    ).rejects.toThrow(/rate limit/);
  });

  it("does NOT retry a non-retryable error (bad request)", async () => {
    const ws = new MemoryWorkspace({});
    const { ai, calls } = scriptedAi([
      { throwError: { statusCode: 400, message: "bad request" } },
    ]);
    await expect(
      runCodingAgent({ workspace: ws, ai, instruction: "go" }),
    ).rejects.toBeTruthy();
    expect(calls()).toBe(1); // one attempt, no retry
  });

  it("stops immediately on an aborted signal without another model call", async () => {
    const ws = new MemoryWorkspace({});
    const ac = new AbortController();
    ac.abort();
    const { ai, calls } = scriptedAi([
      { parts: [{ type: "text-delta", text: "x" }] },
    ]);
    await expect(
      runCodingAgent({
        workspace: ws,
        ai,
        instruction: "go",
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toBe(0);
  });

  it("respects maxSteps as a runaway backstop", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    // Every step wants to call a tool → would loop forever without the cap.
    const { ai, calls } = scriptedAi([
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "read_file",
            input: { path: "a.ts" },
          },
        ],
      },
    ]);
    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "go",
      maxSteps: 3,
    });
    expect(calls()).toBe(3);
    expect(result.steps).toBe(3);
  });
});

describe("runCodingAgent – loop detection", () => {
  it("injects a corrective nudge after 3 identical failing tool calls", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    // Each step: the model issues the SAME edit that errors, until (after the
    // nudge) a final step stops. We assert a nudge user-message was appended.
    let call = 0;
    const failPart = {
      type: "tool-error",
      toolCallId: "c",
      toolName: "edit_file",
      input: { path: "a.ts", old_string: "nope", new_string: "y" },
      error: new Error("String not found in a.ts"),
    };
    const ai: AgentAi = {
      stream(_args: ModelRunArgs) {
        call++;
        const stop = call >= 4; // steps 1-3 fail identically, step 4 stops
        return {
          fullStream: (async function* () {
            if (stop) {
              yield {
                type: "text-delta",
                text: "giving up, different approach",
              };
            } else {
              yield failPart;
            }
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({
            messages: [{ role: "assistant", content: "" }],
          }),
          finishReason: Promise.resolve(stop ? "stop" : "tool-calls"),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };
    const result = await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "fix it",
      maxSteps: 10,
    });
    // A nudge (role user, mentions the repeated tool) was injected into history.
    const nudge = result.messages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("edit_file") &&
        m.content.includes("times"),
    );
    expect(nudge).toBeTruthy();
  });
});

describe("runCodingAgent – extraTools + wrapTools seams (engine unification)", () => {
  it("merges extraTools and applies wrapTools to the tool set the model sees", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    let seenToolNames: string[] = [];
    let wrapApplied = false;

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        // Capture the tool set the model was handed.
        seenToolNames = Object.keys(args.tools);
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "ok" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({ messages: [] }),
          finishReason: Promise.resolve("stop"),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };

    const extraTools = {
      mcp_search: {
        description: "external MCP tool",
        inputSchema: {},
        execute: async () => "hit",
      },
    } as unknown as import("ai").ToolSet;

    await runCodingAgent({
      workspace: ws,
      ai,
      instruction: "go",
      extraTools,
      wrapTools: (tools) => {
        wrapApplied = true;
        return tools; // identity wrapper is enough to prove it ran
      },
    });

    // The built-in workspace tools AND the injected MCP tool are present.
    expect(seenToolNames).toContain("read_file");
    expect(seenToolNames).toContain("bash");
    expect(seenToolNames).toContain("mcp_search");
    // The final wrapper ran over the complete set.
    expect(wrapApplied).toBe(true);
  });
});
