/**
 * Integration coverage for the executeTurn seam (agent-engine v2 Phase 1) —
 * the plan's exit-criterion test: prompt → engine → tool execution → events →
 * result, driven through @oxagen/agent-runner exactly the way a platform
 * surface drives it. The bare path crosses every real engine layer wired in
 * Phase 0 too (dispatch guard, speculation, edit-integrity ledger). House
 * style: dependency injection — MemoryWorkspace + a scripted AgentAi; the
 * engine itself is never mocked.
 */
import { describe, it, expect } from "vitest";
import {
  MemoryWorkspace,
  type AgentAi,
  type ModelRunArgs,
} from "@oxagen/agent-engine";
import { executeTurn, executePipelineTurn, type CodingEvent } from "./index";

/** One-step scripted model: invokes edit_file via its tool, then answers. */
function makeEditingAi(): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          const edit = args.tools["edit_file"] as {
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
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () =>
      ({ object: {} as never, usage: { totalTokens: 0 } }) as never,
  };
}

describe("executeTurn — bare loop (the production chat path)", () => {
  it("runs prompt → engine → tool → events → result through the seam", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];

    const result = await executeTurn("chat", {
      workspace: ws,
      ai: makeEditingAi(),
      instruction: "rename foo to bar",
      onEvent: (e) => events.push(e),
    });

    // The turn's answer and the applied edit both came back through the seam.
    // (MemoryWorkspace.diff() is header-only by contract, so the edit itself
    // is asserted against the workspace content.)
    expect(result.text).toBe("done");
    expect(result.changedFiles).toEqual(["a.ts"]);
    expect(result.diff).toContain("a/a.ts");
    expect(await ws.readFile("a.ts")).toBe("bar");
    // The event stream observed the real tool execution and the final diff.
    expect(events.some((e) => e.type === "file-edit")).toBe(true);
    expect(events.some((e) => e.type === "final-diff")).toBe(true);
  });
});

describe("executePipelineTurn — judged pipeline (the repo-edit path)", () => {
  it("runs the full evaluate→execute→judge pipeline through the seam", async () => {
    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "pipeline done" };
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
      generateObject: (args: { system?: string }) => {
        if (args.system?.includes("evaluation stage")) {
          return Promise.resolve({
            object: {
              completeness: 70,
              complexity: 40,
              recommendedTier: "balanced",
              missing: [],
              contextQueries: [],
              refinedPrompt: "refined prompt",
              removed: [],
              reasoning: "well scoped",
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }) as never;
        }
        // Judge branch: always complete — no revise round in this smoke test.
        return Promise.resolve({
          object: {
            complete: true,
            confidence: 90,
            findings: [],
            remainingWork: [],
            reasoning: "looks done",
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as never;
      },
    };

    const result = await executePipelineTurn("repo-edit", {
      prompt: "say done",
      workspace: new MemoryWorkspace({}),
      ai,
    });

    expect(result.text).toBe("pipeline done");
    expect(result.trace).toBeDefined();
  });
});
