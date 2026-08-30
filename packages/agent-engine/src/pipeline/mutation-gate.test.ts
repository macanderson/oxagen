/**
 * Pipeline (runTurn) — mutation gate wiring.
 *
 * Proves the deterministic mutation gate is wired into the judge/revise loop:
 *  1. A judged-complete turn whose tests still pass with the fix REVERTED is
 *     overridden to incomplete, revised through the EXISTING loop, and lands
 *     with finalComplete=false and the gate verdicts on the trace.
 *  2. A turn whose tests fail without the fix stays complete ("witnessed").
 *  3. A turn with no witness evidence is skipped — verdict untouched.
 *  4. OXAGEN_MUTATION_VERIFY=0 disables the gate entirely.
 *
 * Reuses the full-pipeline mock harness shape from scope-review.test.ts, with
 * a workspace whose diff() returns a REAL unified diff and whose exec() sees
 * the reverted file contents — the same observability trick gate.test.ts uses.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

beforeAll(() => {
  process.env["OXAGEN_LLM_EVALUATOR"] = "anthropic/claude-haiku-4.5";
});
afterAll(() => {
  delete process.env["OXAGEN_LLM_EVALUATOR"];
});

import { runTurn } from "./index";
import type { AgentAi, ModelRunArgs } from "../ports";
import type { CommandResult, Workspace } from "../types";

const WITNESS = "pnpm vitest run src/calc.test.ts";
const FIXED = "export const answer = () => 42;\n";
const ORIGINAL = "export const answer = () => 41;\n";

const DIFF = [
  "diff --git a/src/calc.ts b/src/calc.ts",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -1 +1 @@",
  "-export const answer = () => 41;",
  "+export const answer = () => 42;",
  "diff --git a/src/calc.test.ts b/src/calc.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/calc.test.ts",
  "@@ -0,0 +1 @@",
  "+import { answer } from './calc';",
].join("\n");

class GateWorkspace implements Workspace {
  readonly root = "/repo";
  files = new Map<string, string>([
    ["src/calc.ts", FIXED],
    ["src/calc.test.ts", "import { answer } from './calc';\n"],
  ]);
  /** Exit code the witness command returns when the fix is REVERTED. */
  exitWithoutFix: number;
  constructor(exitWithoutFix: number) {
    this.exitWithoutFix = exitWithoutFix;
  }
  async readFile(p: string): Promise<string> {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`ENOENT: ${p}`);
    return t;
  }
  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }
  async editFile(): Promise<number> {
    throw new Error("not used");
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async glob(): Promise<string[]> {
    return [];
  }
  async grep(): Promise<string[]> {
    return [];
  }
  async exec(command: string): Promise<CommandResult> {
    const reverted = this.files.get("src/calc.ts") === ORIGINAL;
    const exitCode = command === WITNESS && reverted ? this.exitWithoutFix : 0;
    return { exitCode, stdout: "", stderr: "", timedOut: false };
  }
  async diff(): Promise<string> {
    return DIFF;
  }
}

/**
 * Faked AgentAi: evaluator object then always-complete judge verdicts, and a
 * stream whose tool loop emits ONE passing bash run of the witness command —
 * exactly what the spec-test oracle needs to record executed test evidence.
 */
function makeAi(opts?: { bashCommand?: string | null }): AgentAi {
  const generateObject = vi
    .fn()
    .mockImplementation((args: { system?: string }) => {
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
  const bashCommand =
    opts?.bashCommand === undefined ? WITNESS : opts.bashCommand;
  return {
    stream(_args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          if (bashCommand !== null) {
            yield {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "bash",
              input: { command: bashCommand },
            };
            yield {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "bash",
              input: { command: bashCommand },
              output: "1 passed",
            };
          }
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

describe("runTurn — mutation gate wiring", () => {
  it("overrides a vacuous complete verdict and drives the revise loop", async () => {
    const ws = new GateWorkspace(0); // tests still pass without the fix
    const stages: string[] = [];
    const result = await runTurn({
      prompt: "fix the answer",
      workspace: ws,
      ai: makeAi(),
      onStage: (e) => stages.push(e.label),
    });

    expect(result.trace.finalComplete).toBe(false);
    // Gate ran on round 0 (vacuous → revise) and again on round 1.
    expect(result.trace.mutationGates?.map((g) => g.status)).toEqual([
      "vacuous",
      "vacuous",
    ]);
    const lastVerdict = result.trace.judgeRounds.at(-1)!;
    expect(lastVerdict.complete).toBe(false);
    expect(lastVerdict.findings.join(" ")).toContain("Mutation gate");
    expect(stages.some((l) => l.includes("VACUOUS"))).toBe(true);
    // The fix survived both shadow runs.
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
  });

  it("keeps a witnessed turn complete", async () => {
    const ws = new GateWorkspace(1); // tests FAIL without the fix — real green
    const result = await runTurn({
      prompt: "fix the answer",
      workspace: ws,
      ai: makeAi(),
    });

    expect(result.trace.finalComplete).toBe(true);
    expect(result.trace.mutationGates?.map((g) => g.status)).toEqual([
      "witnessed",
    ]);
    expect(result.trace.judgeRounds).toHaveLength(1);
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
  });

  it("skips silently when the agent never ran a test command", async () => {
    const ws = new GateWorkspace(1);
    const stages: string[] = [];
    const result = await runTurn({
      prompt: "fix the answer",
      workspace: ws,
      ai: makeAi({ bashCommand: null }),
      onStage: (e) => stages.push(e.label),
    });

    expect(result.trace.finalComplete).toBe(true);
    expect(result.trace.mutationGates?.map((g) => g.status)).toEqual([
      "skipped",
    ]);
    expect(stages.some((l) => l.includes("mutation gate"))).toBe(false);
  });

  it("is disabled entirely by OXAGEN_MUTATION_VERIFY=0", async () => {
    process.env["OXAGEN_MUTATION_VERIFY"] = "0";
    try {
      const ws = new GateWorkspace(0);
      const result = await runTurn({
        prompt: "fix the answer",
        workspace: ws,
        ai: makeAi(),
      });
      expect(result.trace.finalComplete).toBe(true);
      expect(result.trace.mutationGates).toBeUndefined();
    } finally {
      delete process.env["OXAGEN_MUTATION_VERIFY"];
    }
  });

  it("never arms on a read-only turn (no revert, no gate verdicts)", async () => {
    const ws = new GateWorkspace(0); // would be vacuous IF the gate ran
    const result = await runTurn({
      prompt: "fix the answer",
      workspace: ws,
      ai: makeAi(),
      readOnly: true,
    });
    expect(result.trace.mutationGates).toBeUndefined();
    expect(result.trace.finalComplete).toBe(true);
    // The working tree was never touched by a shadow revert.
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
  });

  it("is disabled by the explicit mutationVerify:false option", async () => {
    const ws = new GateWorkspace(0);
    const result = await runTurn({
      prompt: "fix the answer",
      workspace: ws,
      ai: makeAi(),
      mutationVerify: false,
    });
    expect(result.trace.finalComplete).toBe(true);
    expect(result.trace.mutationGates).toBeUndefined();
  });
});
