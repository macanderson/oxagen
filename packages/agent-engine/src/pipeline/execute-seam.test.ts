/**
 * The pipeline's engine seam: every execution segment — judged rounds and the
 * bare path alike — goes through `RunTurnOptions.execute` when one is
 * supplied, and the in-process loop is never entered.
 *
 * This is what lets `executePipelineTurn` route a judged turn through the same
 * engine selection as a bare one without the pipeline ever importing
 * `@oxagen/agent-runner` (the dependency points the other way).
 */
import { describe, expect, test, vi } from "vitest";
import type { RunCodingAgentOptions, RunCodingAgentResult } from "../types";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";

function scriptedSegment(text: string) {
  return vi.fn(
    async (options: RunCodingAgentOptions): Promise<RunCodingAgentResult> => ({
      text,
      steps: 1,
      diff: "",
      changedFiles: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [
        { role: "user", content: options.instruction },
        { role: "assistant", content: text },
      ],
    }),
  );
}

describe("RunTurnOptions.execute", () => {
  test("the bare path runs its segment through the seam", async () => {
    const execute = scriptedSegment("seam answered");
    const result = await runTurn({
      prompt: "do the thing",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: {
        stream: () => {
          throw new Error("the in-process loop must not be entered");
        },
        generateObject: async () => {
          throw new Error("no model call belongs on this path");
        },
      },
      bare: true,
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].instruction).toContain("do the thing");
    expect(result.text).toBe("seam answered");
  });
});
