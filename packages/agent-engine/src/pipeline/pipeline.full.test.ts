/**
 * Pipeline (runTurn) — the FULL pipeline path.
 *
 * The bare path is covered in pipeline.test.ts; this exercises the real
 * eval → enhance → route → execute → judge → revise loop with a faked AgentAi
 * (structured output for the evaluator/judge, a streaming tool loop that edits a
 * file and runs a command). Covers: stage emission, trace assembly, the routing
 * safety floor, the auto-revise loop + gotcha memory, readOnly disabling revise,
 * a pinned model, verbose telemetry, the judge panel, graph sync, and every
 * streamed callback.
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import { modelForTier } from "../router/model-router";
import type { AgentAi, ModelRunArgs, GraphSyncProvider } from "../ports";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

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
          input: { path: b.editFile, old_string: "before", new_string: "after" },
        };
        const editTool = args.tools["edit_file"] as {
          execute: (i: unknown, o: unknown) => Promise<unknown>;
        };
        await editTool.execute({ path: b.editFile, old_string: "before", new_string: "after" }, {});
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
  const generateObject = vi.fn().mockImplementation((args: { system?: string }) => {
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
        findings: spec.findings ?? (spec.complete ? [] : ["tests were not added"]),
        remainingWork: spec.remainingWork ?? (spec.complete ? [] : ["add tests"]),
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
        : { editFile: round === 0 ? "src/a.ts" : undefined, bash: round === 0, reasoning: "thinking hard" };
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
      prompt: "improve src/a.ts",
      workspace: ws,
      ai,
      onStage: (e) => stages.push(e.kind),
    });

    expect(stages).toEqual(
      expect.arrayContaining(["evaluate", "enhance", "route", "execute", "judge", "complete"]),
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

    const result = await runTurn({ prompt: "auth work", workspace: ws, ai });
    expect(result.trace.selectedTier).toBe("precise");
    expect(result.trace.selectionRationale).toContain("safety floor");
  });

  it("drives the auto-revise loop and records a gotcha memory", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const remember = vi.fn();
    const { ai } = makeAi({
      judgeVerdicts: [{ complete: false, findings: ["no tests"] }, { complete: true }],
      stream: (round) => ({ editFile: round === 0 ? "src/a.ts" : undefined, reasoning: "r" }),
    });

    const result = await runTurn({
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

  it("does not revise in readOnly mode even when judged incomplete", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi({
      judgeVerdicts: [{ complete: false }],
      stream: () => ({ reasoning: "read-only analysis" }), // no file edit in read-only
    });

    const result = await runTurn({ prompt: "explain src/a.ts", workspace: ws, ai, readOnly: true });
    expect(result.trace.judgeRounds).toHaveLength(1);
    expect(result.trace.finalComplete).toBe(false);
  });

  it("honours a pinned model and skips auto-routing", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi();
    const result = await runTurn({ prompt: "do it", workspace: ws, ai, model: "openai/gpt-5" });
    expect(result.trace.selectedModel).toBe("openai/gpt-5");
    expect(result.trace.selectionRationale).toBe("pinned model");
    expect(result.trace.selectedTier).toBe("precise"); // gpt-5 → precise tier
  });

  it("captures per-phase + tool telemetry in verbose mode", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const { ai } = makeAi();
    const result = await runTurn({ prompt: "do it", workspace: ws, ai, verbose: true });
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
      prompt: "do it",
      workspace: ws,
      ai,
      judgeModels: ["openai/gpt-5", "google/gemini-2.5-pro"],
    });
    expect(result.trace.judgeRounds[0]!.model).toContain("panel(");
  });

  it("fires graph sync (ensureGraph + recordLineage) after touching files", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const ensureGraph = vi.fn().mockResolvedValue(undefined);
    const recordLineage = vi.fn().mockResolvedValue(undefined);
    const graphSync: GraphSyncProvider = { ensureGraph, recordLineage };
    const { ai } = makeAi();

    await runTurn({ prompt: "do it", workspace: ws, ai, graphSync });
    await tick();

    expect(ensureGraph).toHaveBeenCalledWith(expect.arrayContaining(["src/a.ts"]));
    expect(recordLineage).toHaveBeenCalledOnce();
  });

  it("records the trace through the injected trace store", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const record = vi.fn();
    const { ai } = makeAi();
    await runTurn({ prompt: "do it", workspace: ws, ai, trace: { record } });
    await tick();
    expect(record).toHaveBeenCalledOnce();
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
      stream: (round) => ({ editFile: round === 0 ? "src/a.ts" : undefined, bash: true, bashRawInput: true }),
    });
    const result = await runTurn({ prompt: "run the tests", workspace: ws, ai });
    // The pipeline could not JSON.parse the input, so it kept the stringified form.
    expect(result.text).toBe("done");
    expect(result.trace.judgeRounds).toHaveLength(1);
  });

  it("marks the enhancement source when both code graph and memory contribute", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const codeGraph = { query: vi.fn().mockResolvedValue("src/a.ts:1: something defined here") };
    const memory = { recallContext: vi.fn().mockResolvedValue("recalled lesson"), remember: vi.fn() };
    const { ai } = makeAi({
      evalObject: { ...DEFAULT_EVAL, contextQueries: ["something"], refinedPrompt: "fix `something`" },
    });

    const result = await runTurn({ prompt: "fix `something`", workspace: ws, ai, codeGraph, memory });
    expect(result.trace.enhancement.source).toBe("code-graph+memory");
    expect(result.trace.enhancement.lessonCount).toBe(1);
    expect(result.trace.enhancement.resolved).toContain("something");
  });
});
