/**
 * Pipeline (runTurn) — scope-review gate.
 *
 * Proves the optional pre-execution "scope review" hook added to the full
 * pipeline path:
 *  1. `onScopeReview` fires exactly once with a fully-populated snapshot.
 *  2. `confirmScope` resolving `{ proceed: false }` cancels the turn BEFORE
 *     any execution round runs (the coding agent's `stream` is never called).
 *  3. `confirmScope` resolving `{ proceed: true, prompt }` flows the edited
 *     prompt into what actually executes.
 *  4. Omitting both options leaves behavior unchanged (no gate at all).
 *
 * Reuses the full-pipeline mock harness from pipeline.full.test.ts (a faked
 * AgentAi that serves the eval schema first, then judge verdicts, in call
 * order, plus a streaming tool loop) rather than inventing a new one.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

beforeAll(() => {
  process.env["OXAGEN_LLM_EVALUATOR"] = "anthropic/claude-haiku-4.5";
});
afterAll(() => {
  delete process.env["OXAGEN_LLM_EVALUATOR"];
});

import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import type { AgentAi, ModelRunArgs } from "../ports";
import type { ScopeReviewInfo } from "../trace/types";
import { scriptedEngine } from "./scripted-engine";

const DEFAULT_EVAL = {
  completeness: 70,
  complexity: 40,
  recommendedTier: "balanced" as const,
  missing: [] as string[],
  contextQueries: [] as string[],
  refinedPrompt: "refined prompt",
  removed: [] as string[],
  reasoning: "well scoped",
};

/** Faked AgentAi: serves the evaluator object, then a "complete" judge verdict,
 * and a streaming tool loop that records the instruction it was invoked with. */
function makeAi(streamSpy: (instruction: string) => void): AgentAi {
  const generateObject = vi
    .fn()
    .mockImplementation((args: { system?: string }) => {
      if (args.system?.includes("evaluation stage")) {
        return Promise.resolve({
          object: DEFAULT_EVAL,
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      }
      return Promise.resolve({
        object: {
          complete: true,
          confidence: 90,
          findings: [],
          remainingWork: [],
          reasoning: "looks done",
        },
        usage: { inputTokens: 3, outputTokens: 2 },
      });
    });
  return {
    stream(args: ModelRunArgs) {
      streamSpy(args.messages?.[args.messages.length - 1]?.content as string);
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "done" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
        }),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject,
  };
}

describe("runTurn — scope review gate", () => {
  it("fires onScopeReview exactly once with a populated snapshot", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const streamSpy = vi.fn();
    const ai = makeAi(streamSpy);
    const seen: ScopeReviewInfo[] = [];

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
      onScopeReview: (info) => seen.push(info),
    });

    expect(seen).toHaveLength(1);
    const info = seen[0]!;
    expect(info.enhancedPrompt.length).toBeGreaterThan(0);
    expect(info.model.length).toBeGreaterThan(0);
    expect(info.originalPrompt).toBe("improve src/a.ts");
    expect(info.refinedPrompt).toBe("refined prompt");
    expect(info.estimatedInputTokens).toBeGreaterThan(0);
    expect(info.estimatedOutputTokens).toBeGreaterThan(0);
    expect(info.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.trace.finalComplete).toBe(true);
  });

  it("cancels the turn without running the coding agent when confirmScope resolves proceed:false", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const streamSpy = vi.fn();
    const ai = makeAi(streamSpy);

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
      confirmScope: async () => ({ proceed: false }),
    });

    // The coding agent's stream() must never have been invoked — cancellation
    // happens strictly before any execution round.
    expect(streamSpy).not.toHaveBeenCalled();
    expect(result.text).toContain("Cancelled");
    expect(result.trace.filesTouched).toHaveLength(0);
    expect(result.trace.finalComplete).toBe(true);
  });

  it("runs the coding agent with the edited prompt when confirmScope resolves proceed:true with a prompt override", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const streamSpy = vi.fn();
    const ai = makeAi(streamSpy);

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
      confirmScope: async () => ({
        proceed: true,
        prompt: "EDITED INSTRUCTION",
      }),
    });

    expect(streamSpy).toHaveBeenCalled();
    expect(streamSpy.mock.calls[0]![0]).toBe("EDITED INSTRUCTION");
    expect(result.trace.enhancement.prompt).toBe("EDITED INSTRUCTION");
    expect(result.text).toBe("done");
  });

  it("behaves exactly as before when neither onScopeReview nor confirmScope is passed", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const streamSpy = vi.fn();
    const ai = makeAi(streamSpy);

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
    });

    expect(streamSpy).toHaveBeenCalled();
    expect(result.text).toBe("done");
    expect(result.trace.finalComplete).toBe(true);
  });
});
