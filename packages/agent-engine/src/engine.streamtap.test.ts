import { describe, it, expect, vi } from "vitest";
import { runCodingAgent } from "./engine";
import type { AgentAi, ModelRunArgs } from "./ports";
import type { CodingEvent, RunCodingAgentOptions } from "./types";

/**
 * Coverage for the three engine seams the in-app chat agent depends on:
 *   1. workspace-optional runs (no filesystem tools, no diff, no final-diff)
 *   2. `onStreamPart` — the raw part tap that reproduces the SSE wire protocol
 *   3. `maxOverflowRetries: 0` — the C1 gate that keeps a non-buffered
 *      transport byte-identical by turning an overflow into a single throw
 *      rather than a silent step re-stream.
 */

/** Minimal streaming result matching the subset the engine consumes. */
function streamResult(
  parts: unknown[],
  usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    steps: Promise.resolve([{}]),
    usage: Promise.resolve(usage),
    response: Promise.resolve({ messages: [] }),
  } as unknown as ReturnType<AgentAi["stream"]>;
}

describe("runCodingAgent — workspace-optional (chat surface)", () => {
  it("advertises NO filesystem tools and emits no final-diff when no workspace is injected", async () => {
    let capturedTools: Record<string, unknown> = {};
    const events: CodingEvent[] = [];
    const extraExecute = vi.fn().mockResolvedValue({ ok: true });

    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        capturedTools = args.tools as Record<string, unknown>;
        return streamResult([{ type: "text-delta", text: "hi" }]);
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };

    const result = await runCodingAgent({
      ai,
      instruction: "answer without a repo",
      model: "anthropic/claude-opus-4-8",
      extraTools: {
        my_capability: {
          description: "a platform capability tool",
          inputSchema: { type: "object" },
          execute: extraExecute,
        } as never,
      },
      onEvent: (e) => events.push(e),
    });

    // The built-in filesystem tools must never appear on a workspace-less run.
    for (const fsTool of [
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "list_dir",
      "search",
      "bash",
    ]) {
      expect(capturedTools[fsTool]).toBeUndefined();
    }
    // Only the caller-supplied capability tool is present.
    expect(Object.keys(capturedTools)).toEqual(["my_capability"]);
    // No repository ⇒ empty diff, no changed files, no final-diff event.
    expect(result.diff).toBe("");
    expect(result.changedFiles).toEqual([]);
    expect(events.some((e) => e.type === "final-diff")).toBe(false);
    expect(result.text).toBe("hi");
  });

  it("no-ops memory.remember and still records trace without a workspace", async () => {
    const remember = vi.fn();
    const record = vi.fn();
    const ai: AgentAi = {
      stream: () => streamResult([{ type: "text-delta", text: "ok" }]),
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };

    await runCodingAgent({
      ai,
      instruction: "q",
      model: "anthropic/claude-opus-4-8",
      memory: { recallContext: async () => "", remember },
      trace: { record },
    });

    await Promise.resolve();
    await Promise.resolve();
    // remember still fires (with empty changedFiles) — it is a no-op sink for chat.
    expect(remember).toHaveBeenCalledWith("coding_turn", {
      instruction: "q",
      changedFiles: [],
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: [] }),
    );
  });
});

describe("runCodingAgent — onStreamPart raw tap", () => {
  it("forwards every fullStream part verbatim, in order, before CodingEvent translation", async () => {
    const parts = [
      { type: "start-step" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "think" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-delta", text: "answer" },
      { type: "finish-step" },
      {
        type: "finish",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ];
    const seen: unknown[] = [];
    const ai: AgentAi = {
      stream: () => streamResult(parts),
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };

    await runCodingAgent({
      ai,
      instruction: "q",
      model: "anthropic/claude-opus-4-8",
      onStreamPart: (p) => seen.push(p),
    });

    // Every part, same objects, same order.
    expect(seen).toEqual(parts);
  });
});

describe("runCodingAgent — maxOverflowRetries gate (C1)", () => {
  const overflowErr = new Error(
    "prompt is too long: maximum context length exceeded",
  );

  function overflowThenSucceedAi(): { ai: AgentAi; calls: () => number } {
    let calls = 0;
    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        calls++;
        if (calls === 1) {
          // Surface the overflow the way the SDK does — via onError, then the
          // stream ends; the engine re-throws the captured streamError.
          return {
            fullStream: (async function* () {
              args.onError?.({ error: overflowErr });
            })(),
            steps: Promise.resolve([{}]),
            usage: Promise.resolve({
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            }),
            response: Promise.resolve({ messages: [] }),
          } as unknown as ReturnType<AgentAi["stream"]>;
        }
        return streamResult([{ type: "text-delta", text: "recovered" }]);
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };
    return { ai, calls: () => calls };
  }

  // A large, shrinkable history so the overflow retry's compaction actually
  // reduces the token estimate (older messages > contentCap get truncated).
  const bigHistory: RunCodingAgentOptions["history"] = Array.from(
    { length: 8 },
    (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(4000),
    }),
  );

  it("default budget retries the step after compacting (overflow recovered)", async () => {
    const { ai, calls } = overflowThenSucceedAi();
    const result = await runCodingAgent({
      ai,
      instruction: "q",
      model: "anthropic/claude-opus-4-8",
      history: bigHistory,
      // High window so pre-call compaction never fires — force the overflow
      // path to be the only thing that compacts.
      contextWindow: 100_000_000,
    });
    expect(calls()).toBe(2);
    expect(result.text).toBe("recovered");
  });

  it("maxOverflowRetries:0 throws the overflow instead of re-running the step", async () => {
    const { ai, calls } = overflowThenSucceedAi();
    await expect(
      runCodingAgent({
        ai,
        instruction: "q",
        model: "anthropic/claude-opus-4-8",
        history: bigHistory,
        contextWindow: 100_000_000,
        maxOverflowRetries: 0,
      }),
    ).rejects.toThrow(/context length/);
    // The step is NOT re-run — the client already saw part of it.
    expect(calls()).toBe(1);
  });
});
