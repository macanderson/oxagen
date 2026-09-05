/**
 * Pipeline (runTurn) — pasted image attachment threading.
 *
 * Proves images reach the coding agent's instruction message in BOTH the bare
 * and full-pipeline paths, and — for the full pipeline's judge/revise loop —
 * that images are attached on round 0 ONLY: a revise round already has them in
 * `history` (round 0's committed messages), so resending would just duplicate
 * the bytes on every round.
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import type { AgentAi, ModelRunArgs } from "../ports";
import { scriptedEngine } from "./scripted-engine";

const DEFAULT_EVAL = {
  completeness: 70,
  complexity: 40,
  recommendedTier: "balanced" as const,
  missing: [] as string[],
  refinedPrompt: "refined prompt",
  removed: [] as string[],
  reasoning: "well scoped",
};

/** Captures the `messages` array `stream` was called with, per execution round. */
function makeCapturingAi(opts: { judgeIncompleteOnce?: boolean } = {}): {
  ai: AgentAi;
  messagesByRound: unknown[][];
} {
  const messagesByRound: unknown[][] = [];
  let round = 0;
  let judged = false;
  const ai: AgentAi = {
    stream(args: ModelRunArgs) {
      messagesByRound.push(args.messages);
      round++;
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
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: vi.fn().mockImplementation((args: { system?: string }) => {
      if (args.system?.includes("evaluation stage")) {
        return Promise.resolve({
          object: DEFAULT_EVAL,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
      // Judge branch: incomplete on the first call (forces a revise round),
      // complete from then on — only relevant when judgeIncompleteOnce is set.
      const complete = !opts.judgeIncompleteOnce || judged;
      judged = true;
      return Promise.resolve({
        object: {
          complete,
          confidence: 90,
          findings: complete ? [] : ["missing tests"],
          remainingWork: complete ? [] : ["add tests"],
          reasoning: complete ? "looks done" : "incomplete",
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }),
  };
  return { ai, messagesByRound };
}

describe("runTurn — pasted image attachment threading", () => {
  it("bare mode: attaches the image to the instruction message", async () => {
    const ws = new MemoryWorkspace({});
    const { ai, messagesByRound } = makeCapturingAi();
    const png = Buffer.from("fake-png");

    await runTurn({
      execute: scriptedEngine,
      prompt: "what's in this image?",
      workspace: ws,
      ai,
      bare: true,
      images: [{ data: png, mediaType: "image/png" }],
    });

    expect(messagesByRound).toHaveLength(1);
    const instructionMsg = messagesByRound[0]!.at(-1) as { content: unknown };
    expect(instructionMsg.content).toEqual([
      { type: "text", text: "what's in this image?" },
      { type: "image", image: png, mediaType: "image/png" },
    ]);
  });

  it("full pipeline: attaches the image on round 0 only, not on a revise round", async () => {
    const ws = new MemoryWorkspace({});
    const { ai, messagesByRound } = makeCapturingAi({
      judgeIncompleteOnce: true,
    });
    const png = Buffer.from("fake-png");

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "what's wrong here?",
      workspace: ws,
      ai,
      maxReviseRounds: 1,
      images: [{ data: png, mediaType: "image/png" }],
    });

    // Judge said incomplete once, so the agent ran twice (round 0 + 1 revise).
    expect(messagesByRound).toHaveLength(2);
    expect(result.trace.judgeRounds.length).toBeGreaterThanOrEqual(2);

    const round0Instruction = messagesByRound[0]!.at(-1) as {
      content: unknown;
    };
    expect(Array.isArray(round0Instruction.content)).toBe(true);
    const round0Parts = round0Instruction.content as Array<
      Record<string, unknown>
    >;
    expect(round0Parts.some((p) => p["type"] === "image")).toBe(true);

    // Round 1 (the revise round) does NOT resend the image as a NEW content
    // part on its own instruction message — it's plain text (the revision
    // prompt); the image only still exists via round 0's message in `history`.
    const round1Instruction = messagesByRound[1]!.at(-1) as {
      content: unknown;
    };
    expect(typeof round1Instruction.content).toBe("string");
  });
});
