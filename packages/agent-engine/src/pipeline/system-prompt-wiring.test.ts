/**
 * Regression: runTurn must deliver the agent's full behavioural contract to the
 * model — persona + operating rules (crucially, "the user cannot see tool output,
 * so interpret and report it") + the repo's project rules — on BOTH execution
 * paths.
 *
 * Before this fix the pipeline passed `system: projectContext?.text` (raw project
 * rules only) and the bare path passed no system at all (the terse engine default),
 * so the agent never received the "report a real status, don't end on a bare tool
 * call" guidance. That is exactly why a "what's the CI status?" turn would run a
 * `gh` command and stop without telling the user the result.
 *
 * These tests capture the `system` string handed to the AI port and assert the
 * operating rules are present and that project rules are COMPOSED with them, not
 * substituted for them.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import type { AgentAi, ModelRunArgs } from "../ports";

/** An AgentAi that records the system prompt it is called with, then returns cleanly. */
function makeCapturingAi(capture: (system: string) => void): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      capture(args.system);
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        response: Promise.resolve({ messages: [] }),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () => ({ object: {} as never, usage: { totalTokens: 0 } }),
  };
}

describe("runTurn — system prompt wiring", () => {
  it("delivers the agent operating rules (report tool results, don't end on a bare tool call)", async () => {
    let captured = "";
    await runTurn({
      prompt: "what's the CI status of the PR?",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: makeCapturingAi((s) => (captured = s)),
      bare: true,
    });

    // The reporting contract must reach the model.
    expect(captured).toContain("the tool's actual output");
    expect(captured.toLowerCase()).toContain("status or diagnostic");
    expect(captured).toContain("substantive reply");
    // And it is the composed agent prompt, not the terse engine default.
    expect(captured).toContain("Operating rules:");
  });

  it("composes the operating rules WITH the repo's project rules (does not replace them)", async () => {
    let captured = "";
    await runTurn({
      prompt: "do the thing",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: makeCapturingAi((s) => (captured = s)),
      bare: true,
      projectContext: { text: "SENTINEL_PROJECT_RULE_XYZ", sources: ["CLAUDE.md"] },
    });

    // Operating rules still present…
    expect(captured).toContain("the tool's actual output");
    // …AND the project rules are appended, not substituted for the rules.
    expect(captured).toContain("SENTINEL_PROJECT_RULE_XYZ");
    expect(captured).toContain("Project rules (from CLAUDE.md)");
  });
});
