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
import { describe, it, expect, vi } from "vitest";
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
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        response: Promise.resolve({ messages: [] }),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    // Serves the judge on the full-pipeline path (the evaluator defaults to the
    // local heuristic and makes no model call): a complete verdict so the turn
    // ends after one round with a well-formed trace.
    generateObject: async () => ({
      object: {
        complete: true,
        findings: [],
        remainingWork: [],
        confidence: 95,
        reasoning: "done",
      } as never,
      usage: { totalTokens: 0 },
    }),
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

  it("threads profile:'headless' into the composed prompt (strips narration, adds protocol)", async () => {
    let captured = "";
    await runTurn({
      prompt: "fix the failing test",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: makeCapturingAi((s) => (captured = s)),
      bare: true,
      profile: "headless",
    });

    // Verification protocol reached the model…
    expect(captured).toContain("Verification protocol");
    expect(captured).toContain("Reproduce");
    expect(captured).toContain("SMALLEST");
    expect(captured.toLowerCase()).toContain("regress");
    // …the live-narration tax was stripped (source wraps "watches this stream\nlive")…
    expect(captured).not.toContain("watches this stream");
    expect(captured).not.toContain("NARRATE AS YOU GO");
    // …and the shared tool rules survived.
    expect(captured).toContain("Prefer `edit_file` for surgical changes");
  });

  it("defaults to the interactive (narrating) profile when none is given", async () => {
    let captured = "";
    await runTurn({
      prompt: "fix the failing test",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: makeCapturingAi((s) => (captured = s)),
      bare: true,
      // no profile ⇒ interactive
    });

    expect(captured).toContain("watches this stream");
    expect(captured).toContain("NARRATE AS YOU GO");
    expect(captured).not.toContain("Verification protocol");
    expect(captured).toContain("Prefer `edit_file` for surgical changes");
  });

  it("composes the operating rules WITH the repo's project rules (does not replace them)", async () => {
    let captured = "";
    await runTurn({
      prompt: "do the thing",
      workspace: new MemoryWorkspace({ "a.ts": "x" }),
      ai: makeCapturingAi((s) => (captured = s)),
      bare: true,
      projectContext: {
        text: "SENTINEL_PROJECT_RULE_XYZ",
        sources: ["CLAUDE.md"],
      },
    });

    // Operating rules still present…
    expect(captured).toContain("the tool's actual output");
    // …AND the project rules are appended, not substituted for the rules.
    expect(captured).toContain("SENTINEL_PROJECT_RULE_XYZ");
    expect(captured).toContain("Project rules (from CLAUDE.md)");
  });

  it("adds the F1 trust-but-verify rule ONLY when ENHANCE produced a localization map (full pipeline)", async () => {
    // Positive: a code graph that resolves the backticked symbol → the F1
    // localizer renders a candidate-locations block during ENHANCE → the
    // executor's system prompt must carry the spec's one-line rule.
    let withGraph = "";
    const codeGraph = {
      query: vi
        .fn()
        .mockResolvedValue(
          "function parseThing — src/parse.ts:10  export function parseThing()",
        ),
    };
    await runTurn({
      prompt: "fix `parseThing` returning null on empty input",
      workspace: new MemoryWorkspace({ "src/parse.ts": "x" }),
      ai: makeCapturingAi((s) => (withGraph = s)),
      codeGraph,
    });
    expect(withGraph).toContain(
      "Candidate locations were computed from the code graph.",
    );
    expect(withGraph).toContain("do not re-derive them.");

    // Negative: the same pipeline without a graph cannot localize, so the
    // rule must be absent — no rule about a block the model never received.
    let withoutGraph = "";
    await runTurn({
      prompt: "fix `parseThing` returning null on empty input",
      workspace: new MemoryWorkspace({ "src/parse.ts": "x" }),
      ai: makeCapturingAi((s) => (withoutGraph = s)),
    });
    expect(withoutGraph).toContain("Operating rules:");
    expect(withoutGraph).not.toContain("do not re-derive them.");
  });
});
