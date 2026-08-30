/**
 * Coverage for the reasoning + abort behavior added to runCodingAgent:
 *   - reasoning-delta parts from the model's fullStream surface as `reasoning`
 *     CodingEvents (distinct from `text`), so the CLI can render them dim.
 *   - an aborted signal makes the loop throw immediately even when the stream
 *     ends cleanly (so callers stop instead of judging/summarizing a cancelled
 *     turn).
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent } from "./engine";
import type { AgentAi, ModelRunArgs } from "./ports";
import type { CodingEvent } from "./types";

function aiYielding(
  parts: Array<{ type: "text-delta" | "reasoning-delta"; text: string }>,
): AgentAi {
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

describe("runCodingAgent – reasoning stream", () => {
  it("emits reasoning events separately from text and only text lands in the result", async () => {
    const events: CodingEvent[] = [];
    const ai = aiYielding([
      { type: "reasoning-delta", text: "let me think… " },
      { type: "reasoning-delta", text: "the fix is X" },
      { type: "text-delta", text: "Done: applied X." },
    ]);

    const result = await runCodingAgent({
      workspace: new MemoryWorkspace({}),
      ai,
      instruction: "do it",
      onEvent: (e) => events.push(e),
    });

    const reasoning = events.filter((e) => e.type === "reasoning");
    const text = events.filter((e) => e.type === "text");
    expect(reasoning.map((e) => (e as { delta: string }).delta)).toEqual([
      "let me think… ",
      "the fix is X",
    ]);
    expect(text.map((e) => (e as { delta: string }).delta)).toEqual([
      "Done: applied X.",
    ]);
    // Reasoning is NOT part of the assistant answer text.
    expect(result.text).toBe("Done: applied X.");
  });
});

describe("runCodingAgent – abort", () => {
  it("throws when the signal is already aborted even if the stream ends cleanly", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCodingAgent({
        workspace: new MemoryWorkspace({}),
        ai: aiYielding([{ type: "text-delta", text: "partial" }]),
        instruction: "cancelled before it mattered",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
