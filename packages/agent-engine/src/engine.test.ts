import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent, changedFilesFromDiff, isErrorResult } from "./engine";
import type {
  AgentAi,
  ModelRunArgs,
  MemoryProvider,
  TraceStore,
} from "./ports";
import type { CodingEvent } from "./types";

describe("changedFilesFromDiff", () => {
  it("extracts b/ paths and ignores /dev/null", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n--- a/y.ts\n+++ /dev/null";
    expect(changedFilesFromDiff(diff)).toEqual(["x.ts"]);
  });
});

describe("isErrorResult", () => {
  it("treats a non-empty error field as failure", () => {
    expect(isErrorResult({ error: "boom" })).toBe(true);
    expect(isErrorResult({ isError: true })).toBe(true);
    expect(isErrorResult(new Error("x"))).toBe(true);
  });

  it("treats an empty/whitespace error string as success (C6)", () => {
    // `{ error: "" }` is a no-error sentinel — it must NOT fire a loop-nudge.
    expect(isErrorResult({ error: "" })).toBe(false);
    expect(isErrorResult({ error: "   " })).toBe(false);
    expect(isErrorResult({ ok: true, error: "" })).toBe(false);
    expect(isErrorResult({ error: null })).toBe(false);
    expect(isErrorResult({ error: false })).toBe(false);
    expect(isErrorResult({ result: "fine" })).toBe(false);
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
            await edit.execute(
              { path: "a.ts", old_string: "foo", new_string: "bar" },
              {},
            );
            yield { type: "text-delta", text: "done" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          }),
          response: Promise.resolve({ messages: [] }),
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
    const ws = new MemoryWorkspace({ "x.ts": "old_value" });

    const recallContext = vi
      .fn()
      .mockResolvedValue("- [constraint] use strict types");
    const remember = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn();

    const memory: MemoryProvider = { recallContext, remember };
    const trace: TraceStore = { record };

    let capturedSystem = "";
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        capturedSystem = args.system;
        capturedMessages = args.messages as Array<{
          role: string;
          content: unknown;
        }>;
        return {
          fullStream: (async function* () {
            const edit = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await edit.execute(
              {
                path: "x.ts",
                old_string: "old_value",
                new_string: "fresh_value",
              },
              {},
            );
            yield { type: "text-delta", text: "ok" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          }),
          response: Promise.resolve({ messages: [] }),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
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
    expect(String(recalledMsg?.content)).toContain(
      "- [constraint] use strict types",
    );

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
      expect.objectContaining({
        instruction: "update x",
        changedFiles: ["x.ts"],
      }),
    );
  });

  it("surfaces a memory-recall failure via onError and still completes the turn", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    // The memory store is down: recallContext rejects.
    const recallContext = vi
      .fn()
      .mockRejectedValue(new Error("neo4j unreachable"));
    const memory: MemoryProvider = { recallContext, remember: vi.fn() };
    const onError = vi.fn();

    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
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
      expect.objectContaining({
        phase: "memory-recall",
        error: expect.any(Error),
      }),
    );
    expect(result.text).toBe("done");
  });

  it("emits each text delta exactly once across a mid-stream failure + retry (C5)", async () => {
    const events: CodingEvent[] = [];
    const rawParts: Array<{ type?: string; text?: string }> = [];
    let call = 0;

    // Attempt 1 streams two deltas then fails mid-stream (retryable). Attempt 2
    // streams the real answer. The buffered attempt-1 emits must be discarded so
    // the consumer never sees the doomed partial replayed.
    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        call += 1;
        const attempt = call;
        return {
          fullStream: (async function* () {
            if (attempt === 1) {
              yield { type: "text-delta", text: "par" };
              yield { type: "text-delta", text: "tial" };
              args.onError?.({ error: new Error("overloaded, please retry") });
            } else {
              yield { type: "text-delta", text: "full answer" };
            }
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

    const result = await runCodingAgent({
      ai,
      instruction: "answer the question",
      model: "anthropic/claude-opus-4-8",
      onEvent: (e) => events.push(e),
      onStreamPart: (p) => rawParts.push(p as { type?: string; text?: string }),
    });

    expect(call).toBe(2); // it did retry
    const deltas = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["full answer"]); // exactly once, no "par"/"tial"
    expect(result.text).toBe("full answer");
    // The raw SSE tap must also not replay the discarded attempt.
    const rawText = rawParts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.text)
      .join("");
    expect(rawText).toBe("full answer");
  });
});
