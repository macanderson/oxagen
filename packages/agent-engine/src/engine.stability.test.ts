/**
 * Engine-stability regressions for {@link runCodingAgent}:
 *   - the stream-inactivity watchdog (stall → retryable step error) and its
 *     interaction with a genuine user abort;
 *   - the `max-steps` stop reason (exhaustion is distinguishable from a finish);
 *   - the mid-flight mutation guard (a step that already ran bash/write/edit is
 *     NOT blind-retried) vs. the pure read-only retry;
 *   - surfacing fire-and-forget memory/trace failures through `onError`;
 *   - the budget-approval "slow wait" breadcrumb.
 */
import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent } from "./engine";
import type {
  AgentAi,
  ModelRunArgs,
  MemoryProvider,
  TraceStore,
} from "./ports";
import type { CodingEvent, EngineNonFatalError } from "./types";

type Part = Record<string, unknown>;

interface Script {
  parts?: Part[];
  /** An error handed to `args.onError` after the parts (a mid-stream stream error). */
  emitError?: unknown;
  /** Hang forever after the parts (a silently stalled transport). */
  hang?: boolean;
  finishReason?: string;
}

/**
 * A scriptable AgentAi: `scripts[i]` drives the i-th `stream()` call (the last
 * script repeats). Records the `messages` each call was given so a test can
 * assert what the loop injected between steps.
 */
function scriptedAi(scripts: Script[]): {
  ai: AgentAi;
  calls: () => number;
  messagesAt: (i: number) => ModelMessage[];
} {
  let call = 0;
  const seenMessages: ModelMessage[][] = [];
  const ai: AgentAi = {
    stream(args: ModelRunArgs) {
      const script = scripts[Math.min(call, scripts.length - 1)]!;
      seenMessages[call] = args.messages;
      call++;
      const hasToolCall = (script.parts ?? []).some(
        (p) => p["type"] === "tool-call",
      );
      const finishReason =
        script.finishReason ?? (hasToolCall ? "tool-calls" : "stop");
      return {
        fullStream: (async function* () {
          for (const p of script.parts ?? []) yield p;
          if (script.emitError) args.onError?.({ error: script.emitError });
          if (script.hang) await new Promise<never>(() => undefined);
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve(finishReason),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () => ({
      object: {} as never,
      usage: { totalTokens: 0 },
    }),
  };
  return {
    ai,
    calls: () => call,
    messagesAt: (i) => seenMessages[i] ?? [],
  };
}

describe("runCodingAgent – stream-stall watchdog", () => {
  it("aborts a stalled step's stream and retries it as a transient error", async () => {
    const { ai, calls } = scriptedAi([
      { parts: [{ type: "text-delta", text: "start" }], hang: true }, // stalls mid-stream
      { parts: [{ type: "text-delta", text: "recovered" }] }, // retry succeeds
    ]);
    const result = await runCodingAgent({
      ai,
      instruction: "do it",
      model: "anthropic/claude-opus-4-8",
      streamStallMs: 50,
    });
    expect(calls()).toBe(2); // it re-ran the stalled step
    expect(result.text).toBe("recovered"); // the doomed attempt's "start" is discarded
  });

  it("does NOT misclassify a genuine user abort during a stall as a retry", async () => {
    const ac = new AbortController();
    const { ai, calls } = scriptedAi([
      { parts: [{ type: "text-delta", text: "start" }], hang: true },
    ]);
    // Abort the turn well before the stall deadline elapses.
    setTimeout(() => ac.abort(), 10);
    await expect(
      runCodingAgent({
        ai,
        instruction: "do it",
        model: "anthropic/claude-opus-4-8",
        streamStallMs: 60,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toBe(1); // the abort ended the turn — no stall-driven retry
  });

  it("never fires the watchdog when parts keep arriving (disabled via streamStallMs=0)", async () => {
    const { ai, calls } = scriptedAi([
      { parts: [{ type: "text-delta", text: "answer" }] },
    ]);
    const result = await runCodingAgent({
      ai,
      instruction: "go",
      model: "anthropic/claude-opus-4-8",
      streamStallMs: 0, // watchdog disabled
    });
    expect(calls()).toBe(1);
    expect(result.text).toBe("answer");
  });

  it("DEFERS the watchdog while a tool executes: a long tool call does NOT false-stall", async () => {
    // Tool execution blocks the fullStream read: the SDK emits tool-call, then
    // the next read stays pending for the WHOLE tool run, then tool-result. With
    // streamStallMs=50 and a 400ms tool, the watchdog fires several times mid-run
    // but must DEFER (a tool is in flight) rather than aborting + retrying. The
    // wide 350ms margin (vs. the 50ms window) keeps this deterministic under CI
    // load — a narrow margin lets timer starvation slip the stall past the tool's
    // completion and spuriously retry.
    let streamCalls = 0;
    const ai: AgentAi = {
      stream() {
        streamCalls++;
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "bash",
              input: { command: "pnpm test" },
            };
            // The "tool" runs 400ms — far past the 50ms stall window, so the
            // watchdog fires repeatedly mid-run and every firing must defer.
            await new Promise((r) => setTimeout(r, 400));
            yield {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "bash",
              input: { command: "pnpm test" },
              output: "42 passed",
            };
            yield { type: "text-delta", text: "tests pass" };
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
    const events: CodingEvent[] = [];
    const result = await runCodingAgent({
      ai,
      instruction: "run the tests",
      model: "anthropic/claude-opus-4-8",
      streamStallMs: 50,
      onEvent: (e) => events.push(e),
    });
    expect(streamCalls).toBe(1); // NOT retried — the long tool did not false-stall
    expect(result.text).toBe("tests pass");
    expect(
      events.some(
        (e) => e.type === "tool-result" && (e as { name: string }).name === "bash",
      ),
    ).toBe(true);
  });

  it("RE-ENGAGES the watchdog after a tool settles: silence with no tool in flight still stalls", async () => {
    // After the tool's result arrives the in-flight counter returns to 0, so a
    // subsequent dead-silent model stream IS a stall and must be retried.
    let streamCalls = 0;
    const ai: AgentAi = {
      stream() {
        streamCalls++;
        const attempt = streamCalls;
        return {
          fullStream: (async function* () {
            if (attempt === 1) {
              yield {
                type: "tool-call",
                toolCallId: "r1",
                toolName: "read_file",
                input: { path: "a.ts" },
              };
              yield {
                type: "tool-result",
                toolCallId: "r1",
                toolName: "read_file",
                input: { path: "a.ts" },
                output: "contents",
              };
              // Tool settled (counter back to 0) — now the model goes dead
              // silent. This is a genuine stall; the watchdog must fire.
              await new Promise<never>(() => undefined);
            } else {
              yield { type: "text-delta", text: "recovered" };
            }
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({ messages: [] }),
          finishReason: Promise.resolve(attempt === 1 ? "tool-calls" : "stop"),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };
    const result = await runCodingAgent({
      ai,
      instruction: "read then hang",
      model: "anthropic/claude-opus-4-8",
      streamStallMs: 50,
    });
    expect(streamCalls).toBe(2); // post-tool silence stalled → retried
    expect(result.text).toBe("recovered");
  });
});

describe("runCodingAgent – max-steps stop reason", () => {
  it("sets stopReason 'max-steps' when the model still wants to act at the cap", async () => {
    // Every step reports finishReason 'tool-calls' — the model never finishes,
    // so the step cap stops the turn: exhaustion, not a clean finish.
    const { ai } = scriptedAi([
      {
        parts: [
          { type: "tool-call", toolCallId: "c", toolName: "grep", input: {} },
        ],
        finishReason: "tool-calls",
      },
    ]);
    const result = await runCodingAgent({
      workspace: new MemoryWorkspace({}),
      ai,
      instruction: "loop forever",
      maxSteps: 2,
    });
    expect(result.stopReason).toBe("max-steps");
    expect(result.steps).toBe(2);
  });

  it("leaves stopReason unset on a natural finish", async () => {
    const { ai } = scriptedAi([{ parts: [{ type: "text-delta", text: "done" }] }]);
    const result = await runCodingAgent({
      ai,
      instruction: "finish cleanly",
      maxSteps: 5,
    });
    expect(result.stopReason).toBeUndefined();
    expect(result.text).toBe("done");
  });
});

describe("runCodingAgent – mid-flight mutation guard", () => {
  it("does NOT blind-retry after a mutating tool ran; injects a corrective message and advances", async () => {
    const { ai, calls, messagesAt } = scriptedAi([
      {
        // Attempt runs a mutating tool, then the stream errors mid-flight.
        parts: [
          {
            type: "tool-call",
            toolCallId: "b1",
            toolName: "bash",
            input: { command: "rm -rf build" },
          },
          {
            type: "tool-result",
            toolCallId: "b1",
            toolName: "bash",
            input: { command: "rm -rf build" },
            output: "ok",
          },
        ],
        emitError: new Error("overloaded, please retry"),
      },
      { parts: [{ type: "text-delta", text: "re-assessed and continued" }] },
    ]);
    const result = await runCodingAgent({
      ai,
      instruction: "clean the build dir",
      model: "anthropic/claude-opus-4-8",
    });
    expect(calls()).toBe(2);
    expect(result.text).toBe("re-assessed and continued");
    // The second call is a NEW step carrying a corrective message — NOT a blind
    // re-run of the identical conversation (which would re-execute bash).
    const secondCallMessages = messagesAt(1);
    const corrective = secondCallMessages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("bash") &&
        m.content.toLowerCase().includes("not retried"),
    );
    expect(corrective).toBeDefined();
  });

  it("still does a pure retry (no corrective message) when only read-only tools ran", async () => {
    const { ai, calls, messagesAt } = scriptedAi([
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: "r1",
            toolName: "read_file",
            input: { path: "a.ts" },
          },
          {
            type: "tool-result",
            toolCallId: "r1",
            toolName: "read_file",
            input: { path: "a.ts" },
            output: "contents",
            durationMs: 0,
          },
        ],
        emitError: new Error("503 service unavailable"),
      },
      { parts: [{ type: "text-delta", text: "finished after retry" }] },
    ]);
    const events: CodingEvent[] = [];
    const result = await runCodingAgent({
      ai,
      instruction: "read then answer",
      model: "anthropic/claude-opus-4-8",
      onEvent: (e) => events.push(e),
    });
    expect(calls()).toBe(2);
    expect(result.text).toBe("finished after retry");
    // A read-only step is re-run verbatim — the conversation carries NO
    // mid-flight corrective message.
    const secondCallMessages = messagesAt(1);
    const hasCorrective = secondCallMessages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.toLowerCase().includes("not retried"),
    );
    expect(hasCorrective).toBe(false);
    // The tool-result event that IS emitted (from the successful attempt) carries
    // a non-negative duration — proving per-attempt timing didn't break.
    const toolResults = events.filter((e) => e.type === "tool-result");
    for (const tr of toolResults) {
      expect((tr as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("runCodingAgent – fire-and-forget error surfacing", () => {
  it("routes a memory.remember failure to onError with phase 'memory-remember'", async () => {
    const remember = vi.fn().mockRejectedValue(new Error("memory store down"));
    const memory: MemoryProvider = {
      recallContext: vi.fn().mockResolvedValue(""),
      remember,
    };
    const onError = vi.fn();
    const { ai } = scriptedAi([{ parts: [{ type: "text-delta", text: "ok" }] }]);
    await runCodingAgent({
      ai,
      instruction: "remember this",
      model: "anthropic/claude-opus-4-8",
      memory,
      onError,
    });
    // Let the fire-and-forget catch settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(remember).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "memory-remember",
        error: expect.any(Error),
      }),
    );
  });

  it("routes a trace.record failure to onError with phase 'trace-record'", async () => {
    const record = vi.fn().mockRejectedValue(new Error("clickhouse timeout"));
    const trace: TraceStore = { record };
    const onError = vi.fn();
    const { ai } = scriptedAi([{ parts: [{ type: "text-delta", text: "ok" }] }]);
    await runCodingAgent({
      ai,
      instruction: "trace this",
      model: "anthropic/claude-opus-4-8",
      trace,
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(record).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "trace-record",
        error: expect.any(Error),
      }),
    );
  });
});

describe("runCodingAgent – budget-approval slow-wait breadcrumb", () => {
  it("emits a 'budget-wait-slow' breadcrumb when the guard blocks past the threshold, then continues", async () => {
    vi.useFakeTimers();
    try {
      const errors: EngineNonFatalError[] = [];
      let releaseGuard!: (v: "continue" | "stop") => void;
      const guardGate = new Promise<"continue" | "stop">((r) => {
        releaseGuard = r;
      });
      let guardCalls = 0;
      const { ai } = scriptedAi([
        { parts: [{ type: "text-delta", text: "step" }] },
      ]);
      const p = runCodingAgent({
        ai,
        instruction: "spend",
        model: "anthropic/claude-opus-4-8",
        budgetGuard: () => {
          guardCalls++;
          return guardGate;
        },
        onError: (e) => errors.push(e),
      });
      // Let the loop reach and enter the budget guard.
      await vi.advanceTimersByTimeAsync(0);
      expect(guardCalls).toBe(1);
      expect(errors).toHaveLength(0);
      // Cross the 60s breadcrumb threshold while the human hasn't answered.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(errors.map((e) => e.phase)).toContain("budget-wait-slow");
      // The wait was NOT auto-denied — only the guard resolving ends it.
      releaseGuard("continue");
      const result = await p;
      expect(result.text).toBe("step");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the breadcrumb when the guard resolves promptly", async () => {
    const errors: EngineNonFatalError[] = [];
    const { ai } = scriptedAi([
      { parts: [{ type: "text-delta", text: "ok" }] },
    ]);
    const result = await runCodingAgent({
      ai,
      instruction: "spend",
      model: "anthropic/claude-opus-4-8",
      budgetGuard: async () => "continue",
      onError: (e) => errors.push(e),
    });
    expect(result.text).toBe("ok");
    expect(errors.some((e) => e.phase === "budget-wait-slow")).toBe(false);
  });
});
