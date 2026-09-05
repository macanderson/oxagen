/**
 * Pipeline (runTurn) — the FULL pipeline path.
 *
 * The bare path is covered in pipeline.test.ts; this exercises the real
 * eval → enhance → route → execute → judge → revise loop with a faked AgentAi
 * (structured output for the evaluator/judge, a streaming tool loop that edits a
 * file and runs a command). Covers: stage emission, trace assembly, the routing
 * safety floor, the auto-revise loop + gotcha memory, readOnly disabling revise,
 * a pinned model, verbose telemetry, the judge panel, and every
 * streamed callback.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// This suite exercises the LLM-evaluation path (the mock `generateObject`
// serves the eval schema first, then judge verdicts, in call order). The
// shipped default evaluator is the local heuristic, which makes no model call —
// pin an LLM evaluator so the mock sequence and trace assertions hold.
beforeAll(() => {
  process.env["OXAGEN_LLM_EVALUATOR"] = "anthropic/claude-haiku-4.5";
});
afterAll(() => {
  delete process.env["OXAGEN_LLM_EVALUATOR"];
});
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import { modelForTier } from "../router/model-router";
import type { AgentAi, ModelRunArgs } from "../ports";
import { scriptedEngine } from "./scripted-engine";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const DEFAULT_EVAL = {
  completeness: 70,
  complexity: 40,
  recommendedTier: "balanced" as const,
  missing: [] as string[],
  refinedPrompt: "refined prompt",
  removed: [] as string[],
  reasoning: "well scoped",
};

interface StreamBehavior {
  editFile?: string;
  bash?: boolean;
  /** Emit the bash tool-result input as a raw (non-JSON) string to exercise the parse fallback. */
  bashRawInput?: boolean;
  reasoning?: string;
}

function makeStream(args: ModelRunArgs, b: StreamBehavior) {
  return {
    fullStream: (async function* () {
      if (b.editFile) {
        yield {
          type: "tool-call",
          toolName: "edit_file",
          toolCallId: "e1",
          input: {
            path: b.editFile,
            old_string: "before",
            new_string: "after",
          },
        };
        const editTool = args.tools["edit_file"] as {
          execute: (i: unknown, o: unknown) => Promise<unknown>;
        };
        await editTool.execute(
          { path: b.editFile, old_string: "before", new_string: "after" },
          {},
        );
        yield {
          type: "tool-result",
          toolName: "edit_file",
          toolCallId: "e1",
          input: { path: b.editFile },
          output: { ok: true },
        };
      }
      if (b.bash) {
        const input = b.bashRawInput ? "pytest -q" : { command: "pytest -q" };
        yield { type: "tool-call", toolName: "bash", toolCallId: "b1", input };
        yield {
          type: "tool-result",
          toolName: "bash",
          toolCallId: "b1",
          input,
          output: "2 passed in 0.01s",
        };
      }
      if (b.reasoning) yield { type: "reasoning-delta", text: b.reasoning };
      yield { type: "text-delta", text: "done" };
    })(),
    steps: Promise.resolve([{}]),
    usage: Promise.resolve({
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      // AI SDK v7 usage shape — the engine reads cache hits from inputTokenDetails.
      inputTokenDetails: { cacheReadTokens: 1 },
    }),
    response: Promise.resolve({ messages: [] }),
    finishReason: Promise.resolve("stop"),
  } as unknown as ReturnType<AgentAi["stream"]>;
}

interface JudgeVerdictSpec {
  complete: boolean;
  findings?: string[];
  remainingWork?: string[];
  confidence?: number;
}

interface AiConfig {
  evalObject?: Record<string, unknown>;
  judgeVerdicts?: JudgeVerdictSpec[];
  stream?: (round: number) => StreamBehavior;
}

function makeAi(cfg: AiConfig = {}) {
  let streamRound = 0;
  let judgeCall = 0;
  const generateObject = vi
    .fn()
    .mockImplementation((args: { system?: string }) => {
      if (args.system?.includes("evaluation stage")) {
        return Promise.resolve({
          object: cfg.evalObject ?? DEFAULT_EVAL,
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      }
      // Judge branch.
      const verdicts = cfg.judgeVerdicts ?? [{ complete: true }];
      const spec = verdicts[Math.min(judgeCall, verdicts.length - 1)]!;
      judgeCall++;
      return Promise.resolve({
        object: {
          complete: spec.complete,
          confidence: spec.confidence ?? 90,
          findings:
            spec.findings ?? (spec.complete ? [] : ["tests were not added"]),
          remainingWork:
            spec.remainingWork ?? (spec.complete ? [] : ["add tests"]),
          reasoning: spec.complete ? "looks done" : "incomplete",
        },
        usage: { inputTokens: 3, outputTokens: 2 },
      });
    });
  const ai: AgentAi = {
    stream(args: ModelRunArgs) {
      const round = streamRound++;
      const b = cfg.stream
        ? cfg.stream(round)
        : {
            editFile: round === 0 ? "src/a.ts" : undefined,
            bash: round === 0,
            reasoning: "thinking hard",
          };
      return makeStream(args, b);
    },
    generateObject,
  };
  return { ai, generateObject };
}

describe("runTurn — full pipeline path", () => {
  it("runs every stage and assembles a complete trace", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const stages: string[] = [];
    const { ai } = makeAi();

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
      onStage: (e) => stages.push(e.kind),
    });

    expect(stages).toEqual(
      expect.arrayContaining([
        "evaluate",
        "enhance",
        "route",
        "execute",
        "judge",
        "complete",
      ]),
    );
    expect(result.text).toBe("done");
    expect(result.trace.evaluation.fallback).toBe(false);
    expect(result.trace.evaluation.completeness).toBe(70);
    expect(result.trace.selectedTier).toBe("balanced");
    expect(result.trace.selectedModel).toBe(modelForTier("balanced"));
    expect(result.trace.judgeRounds).toHaveLength(1);
    expect(result.trace.finalComplete).toBe(true);
    expect(result.trace.filesTouched).toContain("src/a.ts");
    expect(result.trace.commandsRun).toContain("pytest -q");
    expect(result.usage.cachedInputTokens).toBe(1);
  });

  it("raises the tier to the precise safety floor when the refined prompt is high-stakes", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      evalObject: {
        ...DEFAULT_EVAL,
        recommendedTier: "fast",
        refinedPrompt: "rework the auth session password flow",
      },
    });

    const result = await runTurn({
      prompt: "auth work",
      workspace: ws,
      ai,
      execute: scriptedEngine,
    });
    expect(result.trace.selectedTier).toBe("precise");
    expect(result.trace.selectionRationale).toContain("safety floor");
  });

  it("drives the auto-revise loop and records a gotcha memory", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const remember = vi.fn();
    const { ai } = makeAi({
      judgeVerdicts: [
        { complete: false, findings: ["no tests"] },
        { complete: true },
      ],
      stream: (round) => ({
        editFile: round === 0 ? "src/a.ts" : undefined,
        reasoning: "r",
      }),
    });

    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "add a feature to src/a.ts",
      workspace: ws,
      ai,
      memory: { recallContext: async () => "", remember },
      maxReviseRounds: 1,
    });

    expect(result.trace.judgeRounds).toHaveLength(2);
    expect(result.trace.finalComplete).toBe(true);
    const gotcha = remember.mock.calls.find((c) => c[0] === "gotcha");
    expect(gotcha).toBeDefined();
  });

  it("reads OXAGEN_MAX_REVISE_ROUNDS as the default when maxReviseRounds is not passed", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      judgeVerdicts: [
        { complete: false, findings: ["no tests"] },
        { complete: true },
      ],
      stream: (round) => ({
        editFile: round === 0 ? "src/a.ts" : undefined,
        reasoning: "r",
      }),
    });

    process.env["OXAGEN_MAX_REVISE_ROUNDS"] = "1";
    try {
      const result = await runTurn({
        execute: scriptedEngine,
        prompt: "add a feature to src/a.ts",
        workspace: ws,
        ai,
        // No maxReviseRounds option — the env var alone must allow round 1.
      });
      expect(result.trace.judgeRounds).toHaveLength(2);
      expect(result.trace.finalComplete).toBe(true);
    } finally {
      delete process.env["OXAGEN_MAX_REVISE_ROUNDS"];
    }
  });

  it("an explicit maxReviseRounds option wins over OXAGEN_MAX_REVISE_ROUNDS", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      judgeVerdicts: [{ complete: false, findings: ["no tests"] }],
      stream: (round) => ({
        editFile: round === 0 ? "src/a.ts" : undefined,
        reasoning: "r",
      }),
    });

    process.env["OXAGEN_MAX_REVISE_ROUNDS"] = "5";
    try {
      const result = await runTurn({
        execute: scriptedEngine,
        prompt: "add a feature to src/a.ts",
        workspace: ws,
        ai,
        maxReviseRounds: 0, // explicit 0 must win, disabling revise despite env=5
      });
      expect(result.trace.judgeRounds).toHaveLength(1);
      expect(result.trace.finalComplete).toBe(false);
    } finally {
      delete process.env["OXAGEN_MAX_REVISE_ROUNDS"];
    }
  });

  it("does not revise in readOnly mode even when judged incomplete", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      judgeVerdicts: [{ complete: false }],
      stream: () => ({ reasoning: "read-only analysis" }), // no file edit in read-only
    });

    // Opt OUT of the default deterministic judge-skip so the judge actually runs
    // and returns incomplete — this asserts the readOnly-never-revises invariant
    // still holds even when the judge says the work is incomplete.
    process.env["OXAGEN_LADDER"] = "0";
    try {
      const result = await runTurn({
        execute: scriptedEngine,
        prompt: "explain src/a.ts",
        workspace: ws,
        ai,
        readOnly: true,
      });
      expect(result.trace.judgeRounds).toHaveLength(1);
      expect(result.trace.finalComplete).toBe(false);
    } finally {
      delete process.env["OXAGEN_LADDER"];
    }
  });

  it("skips the judge model call on a read-only turn with no diff (ADR-021 §1)", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    // judgeVerdicts would say incomplete IF the judge ran — it must not.
    const { ai, generateObject } = makeAi({
      judgeVerdicts: [{ complete: false }],
      stream: () => ({ reasoning: "read-only analysis" }), // no file edit ⇒ empty diff
    });

    // Default behavior (judge-skip ON): no OXAGEN_LADDER set.
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "explain src/a.ts",
      workspace: ws,
      ai,
      readOnly: true,
    });

    // The judge (completeness) model was never invoked — only the evaluator.
    const judgeCalls = generateObject.mock.calls.filter(([a]) =>
      (a as { system?: string }).system?.includes("completeness judge"),
    );
    expect(judgeCalls).toHaveLength(0);
    expect(result.trace.judgeRounds).toHaveLength(1);
    expect(result.trace.judgeRounds[0]!.model).toBe("deterministic/read-only");
    expect(result.trace.finalComplete).toBe(true);
  });

  it("fastPath skips the judge on a non-readOnly turn that changed nothing", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    // judgeVerdicts would say incomplete IF the judge ran — it must not.
    const { ai, generateObject } = makeAi({
      judgeVerdicts: [{ complete: false }],
      stream: () => ({ reasoning: "conversational answer" }), // no file edit ⇒ empty diff
    });

    // A lookup turn: NOT readOnly (so the ADR-021 read-only skip does not apply),
    // but fastPath opts into skipping the judge on a zero diff.
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "what's the command to add an MCP server?",
      workspace: ws,
      ai,
      fastPath: true,
    });

    const judgeCalls = generateObject.mock.calls.filter(([a]) =>
      (a as { system?: string }).system?.includes("completeness judge"),
    );
    expect(judgeCalls).toHaveLength(0);
    expect(result.trace.judgeRounds).toHaveLength(1);
    expect(result.trace.judgeRounds[0]!.model).toBe("deterministic/fast-path");
    expect(result.trace.finalComplete).toBe(true);
  });

  it("fastPath still judges when the turn unexpectedly edits files (zero-diff guard)", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    // A misclassified fast-path turn that DOES edit: the fast-path skip must NOT
    // fire (it is guarded on a zero diff), so the safety net is not lost —
    // classification accuracy only gates the cheap planner skip, never the judge.
    const { ai } = makeAi({ judgeVerdicts: [{ complete: true }] });

    // Opt out of the orthogonal ladder skip so the real judge runs and we can
    // prove the fast-path deterministic skip did not swallow it on a diff turn.
    process.env["OXAGEN_LADDER"] = "0";
    try {
      const result = await runTurn({
        execute: scriptedEngine,
        prompt: "add a filesystem MCP",
        workspace: ws,
        ai,
        fastPath: true,
      });
      // The real judge ran — the verdict carries an advisor model slug, NOT the
      // fast-path deterministic marker (which only fires on a zero diff).
      expect(result.trace.judgeRounds).toHaveLength(1);
      expect(result.trace.judgeRounds[0]!.model).not.toBe(
        "deterministic/fast-path",
      );
      expect(result.trace.judgeRounds[0]!.model).toContain("/");
    } finally {
      delete process.env["OXAGEN_LADDER"];
    }
  });

  it("honours a pinned model and skips auto-routing", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi();
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "do it",
      workspace: ws,
      ai,
      model: "openai/gpt-5",
    });
    expect(result.trace.selectedModel).toBe("openai/gpt-5");
    expect(result.trace.selectionRationale).toBe("pinned model");
    expect(result.trace.selectedTier).toBe("precise"); // gpt-5 → precise tier
  });

  it("captures per-phase + tool telemetry in verbose mode", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi();
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "do it",
      workspace: ws,
      ai,
      verbose: true,
    });
    expect(result.trace.verbose).toBe(true);
    expect(result.trace.phases?.length).toBeGreaterThan(0);
    // edit + bash tool results both captured.
    expect((result.trace.toolEvents ?? []).length).toBeGreaterThanOrEqual(2);
    expect(result.trace.thinkingLog?.[0]?.text).toContain("thinking");
  });

  it("judges with a cross-vendor panel when judgeModels are supplied", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi();
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "do it",
      workspace: ws,
      ai,
      judgeModels: ["openai/gpt-5", "google/gemini-2.5-pro"],
    });
    expect(result.trace.judgeRounds[0]!.model).toContain("panel(");
  });

  it("records the trace through the injected trace store", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const record = vi.fn();
    const { ai } = makeAi();
    await runTurn({
      prompt: "do it",
      workspace: ws,
      ai,
      trace: { record },
      execute: scriptedEngine,
    });
    await tick();
    expect(record).toHaveBeenCalledOnce();
  });

  it("surfaces a failing trace record through onError instead of swallowing it", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const record = vi.fn().mockRejectedValue(new Error("clickhouse timeout"));
    const onError = vi.fn();
    const { ai } = makeAi();

    await runTurn({
      execute: scriptedEngine,
      prompt: "do it",
      workspace: ws,
      ai,
      trace: { record },
      onError,
    });
    await tick();
    await tick();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "trace-record",
        error: expect.any(Error),
      }),
    );
  });

  it("forwards every streamed event to its callback", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const texts: string[] = [];
    const reasonings: string[] = [];
    const toolCalls: string[] = [];
    const toolEvents: Array<{ name: string }> = [];
    const fileChanges: string[][] = [];
    const { ai } = makeAi();

    await runTurn({
      execute: scriptedEngine,
      prompt: "do it",
      workspace: ws,
      ai,
      onText: (d) => texts.push(d),
      onReasoning: (d) => reasonings.push(d),
      onToolCall: (n) => toolCalls.push(n),
      onToolEvent: (e) => toolEvents.push(e),
      onFileChange: (_diff, files) => fileChanges.push(files),
    });

    expect(texts.join("")).toContain("done");
    expect(reasonings.join("")).toContain("thinking");
    expect(toolCalls).toContain("edit_file");
    expect(toolCalls).toContain("bash");
    expect(toolEvents.length).toBeGreaterThan(0);
    expect(fileChanges.some((f) => f.includes("src/a.ts"))).toBe(true);
  });

  it("keeps the raw command string when a bash tool-result input is not JSON", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      stream: (round) => ({
        editFile: round === 0 ? "src/a.ts" : undefined,
        bash: true,
        bashRawInput: true,
      }),
    });
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "run the tests",
      workspace: ws,
      ai,
    });
    // The pipeline could not JSON.parse the input, so it kept the stringified form.
    expect(result.text).toBe("done");
    expect(result.trace.judgeRounds).toHaveLength(1);
  });

  it("marks the enhancement source as memory when recall contributes", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const memory = {
      recallContext: vi.fn().mockResolvedValue("recalled lesson"),
      remember: vi.fn(),
    };
    const { ai } = makeAi({
      evalObject: {
        ...DEFAULT_EVAL,
        refinedPrompt: "fix `something`",
      },
    });

    const stages: string[] = [];
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "fix `something`",
      workspace: ws,
      ai,
      memory,
      onStage: (e) => {
        if (e.kind === "enhance") stages.push(e.label);
      },
    });
    expect(result.trace.enhancement.source).toBe("memory");
    expect(result.trace.enhancement.lessonCount).toBe(1);
    expect(result.trace.enhancement.context).toContain("recalled lesson");
    expect(stages[0]).toContain("memory");
  });

  it("marks the enhancement source as none when nothing was recalled", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      evalObject: { ...DEFAULT_EVAL, refinedPrompt: "improve the login flow" },
    });

    const stages: string[] = [];
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "improve the login flow",
      workspace: ws,
      ai,
      onStage: (e) => {
        if (e.kind === "enhance") stages.push(e.label);
      },
    });

    expect(result.trace.enhancement.source).toBe("none");
    expect(result.trace.enhancement.context).toBe("");
    expect(stages[0]).toContain("no extra context found");
  });
});
