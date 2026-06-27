/**
 * Turn pipeline — proves the orchestration: evaluate → enhance → route → execute
 * → judge → revise, the trace it assembles, model selection (evaluator ⟂ router,
 * manual pin), the auto-revise loop and its guards (readOnly, maxReviseRounds),
 * bare mode, stage emission, usage accumulation, and the gateway-key guard. Every
 * stage module is mocked, so no gateway or filesystem is touched.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { PromptEvaluation, JudgeVerdict, StageEvent } from "../trace.js";

vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));
vi.mock("../env.js", () => {
  class MissingGatewayKeyError extends Error {
    constructor() {
      super("missing");
      this.name = "MissingGatewayKeyError";
    }
  }
  return { ensureGatewayKey: vi.fn(() => "key"), MissingGatewayKeyError };
});
vi.mock("../loop.js", () => ({ runAgent: vi.fn() }));
vi.mock("../evaluator.js", () => ({ evaluatePrompt: vi.fn() }));
vi.mock("../judge.js", () => ({
  judgeCompleteness: vi.fn(),
  buildRevisionPrompt: vi.fn(() => "REVISION PROMPT"),
}));
vi.mock("../prompt-enhancer.js", () => ({ enhancePrompt: vi.fn() }));

import { runTurn, MissingGatewayKeyError } from "../pipeline.js";
import { ensureGatewayKey } from "../env.js";
import { runAgent } from "../loop.js";
import { evaluatePrompt } from "../evaluator.js";
import { judgeCompleteness, buildRevisionPrompt } from "../judge.js";
import { enhancePrompt } from "../prompt-enhancer.js";

const mockEnsure = ensureGatewayKey as unknown as Mock;
const mockRun = runAgent as unknown as Mock;
const mockEval = evaluatePrompt as unknown as Mock;
const mockJudge = judgeCompleteness as unknown as Mock;
const mockEnhance = enhancePrompt as unknown as Mock;
const mockBuildRevision = buildRevisionPrompt as unknown as Mock;

function evaluation(over: Partial<PromptEvaluation> = {}): PromptEvaluation {
  return {
    completeness: 70,
    complexity: 50,
    recommendedTier: "balanced",
    missing: [],
    contextQueries: ["Foo"],
    refinedPrompt: "refined ask",
    removed: [],
    reasoning: "r",
    fallback: false,
    model: "anthropic/claude-haiku-4.5",
    usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
    ...over,
  };
}

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    complete: true,
    confidence: 90,
    findings: [],
    remainingWork: [],
    reasoning: "looks done",
    model: "anthropic/claude-opus-4.8",
    fallback: false,
    usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.002 },
    ...over,
  };
}

beforeEach(() => {
  delete process.env["OXAGEN_LLM_FAST"];
  delete process.env["OXAGEN_LLM_BALANCED"];
  delete process.env["OXAGEN_LLM_PRECISE"];
  mockEnsure.mockReturnValue("key");
  mockEval.mockResolvedValue(evaluation());
  mockEnhance.mockResolvedValue({
    prompt: "refined ask\n\n## context",
    context: "## context",
    resolved: ["Foo"],
    lessons: [],
  });
  mockJudge.mockResolvedValue(verdict());
  mockBuildRevision.mockReturnValue("REVISION PROMPT");
  // Default executor: streams text, touches a file, returns a message + usage.
  mockRun.mockImplementation(async (opts: Record<string, unknown>) => {
    (opts.onToolCall as (n: string, i: unknown) => void)?.("write_file", { path: "src/x.ts" });
    (opts.onText as (d: string) => void)?.("hi");
    return {
      text: "done",
      steps: 2,
      messages: [{ role: "assistant", content: "done" }],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  });
});

describe("runTurn — happy path", () => {
  it("runs all stages, selects the model, and assembles a complete trace", async () => {
    const stages: StageEvent[] = [];
    const res = await runTurn({ prompt: "fix Foo", cwd: "/x", onStage: (s) => stages.push(s) });

    expect(mockEval).toHaveBeenCalledOnce();
    expect(mockEnhance).toHaveBeenCalledOnce();
    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockJudge).toHaveBeenCalledOnce();

    // The executor saw the enhanced prompt on the balanced (sonnet) model.
    expect(mockRun.mock.calls[0]?.[0].prompt).toContain("## context");
    expect(mockRun.mock.calls[0]?.[0].model).toContain("sonnet");

    const t = res.trace;
    expect(t.originalPrompt).toBe("fix Foo");
    expect(t.selectedTier).toBe("balanced");
    expect(t.selectionRationale).toContain("evaluator recommended");
    expect(t.judgeRounds).toHaveLength(1);
    expect(t.finalComplete).toBe(true);
    expect(t.filesTouched).toEqual(["src/x.ts"]);
    expect(t.enhancement.source).toBe("code-graph");
    // Usage accumulates evaluator + executor + judge token counts.
    expect(t.usage.inputTokens).toBe(108);
    expect(t.usage.outputTokens).toBe(52);
    expect(t.usage.costUsd).toBeGreaterThan(0);

    // Stages are emitted in order.
    expect(stages.map((s) => s.kind)).toEqual([
      "evaluate",
      "enhance",
      "route",
      "execute",
      "judge",
      "complete",
    ]);
  });

  it("forwards the evaluator's context queries to the enhancer", async () => {
    await runTurn({ prompt: "fix Foo", cwd: "/x" });
    expect(mockEnhance.mock.calls[0]?.[0].extraQueries).toEqual(["Foo"]);
  });
});

describe("runTurn — completeness revise loop", () => {
  it("sends the agent back when judged incomplete, then re-judges", async () => {
    mockJudge
      .mockResolvedValueOnce(verdict({ complete: false, findings: ["no test"] }))
      .mockResolvedValueOnce(verdict({ complete: true }));

    const stages: StageEvent[] = [];
    const res = await runTurn({ prompt: "add x", cwd: "/x", onStage: (s) => stages.push(s) });

    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockBuildRevision).toHaveBeenCalledOnce();
    // The second execution runs the revision prompt.
    expect(mockRun.mock.calls[1]?.[0].prompt).toBe("REVISION PROMPT");
    expect(res.trace.judgeRounds).toHaveLength(2);
    expect(res.trace.finalComplete).toBe(true);
    expect(stages.some((s) => s.kind === "revise")).toBe(true);
  });

  it("does not revise in read-only mode", async () => {
    mockJudge.mockResolvedValue(verdict({ complete: false, findings: ["x"] }));
    const res = await runTurn({ prompt: "add x", cwd: "/x", readOnly: true });
    expect(mockRun).toHaveBeenCalledOnce();
    expect(res.trace.finalComplete).toBe(false);
  });

  it("does not revise when maxReviseRounds is 0", async () => {
    mockJudge.mockResolvedValue(verdict({ complete: false, findings: ["x"] }));
    const res = await runTurn({ prompt: "add x", cwd: "/x", maxReviseRounds: 0 });
    expect(mockRun).toHaveBeenCalledOnce();
    expect(res.trace.judgeRounds).toHaveLength(1);
  });
});

describe("runTurn — model selection", () => {
  it("pins a manually overridden model and skips routing", async () => {
    const res = await runTurn({ prompt: "x", cwd: "/x", model: "openai/gpt-5" });
    expect(res.trace.selectedModel).toBe("openai/gpt-5");
    expect(res.trace.selectionRationale).toBe("pinned model");
    expect(mockRun.mock.calls[0]?.[0].model).toBe("openai/gpt-5");
  });

  it("escalates above the evaluator on high-stakes signals", async () => {
    mockEval.mockResolvedValue(
      evaluation({ recommendedTier: "fast", refinedPrompt: "implement the stripe billing refund" }),
    );
    const res = await runTurn({ prompt: "billing", cwd: "/x" });
    expect(res.trace.selectedTier).toBe("precise");
    expect(res.trace.selectedModel).toContain("opus");
    expect(res.trace.selectionRationale).toContain("router escalated");
  });
});

describe("runTurn — bare mode", () => {
  it("skips eval/enhance/judge and still produces a trace", async () => {
    const res = await runTurn({ prompt: "x", cwd: "/x", bare: true });
    expect(mockEval).not.toHaveBeenCalled();
    expect(mockEnhance).not.toHaveBeenCalled();
    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledOnce();
    expect(res.trace.judgeRounds).toHaveLength(0);
    expect(res.trace.selectionRationale).toBe("bare mode (no routing)");
    expect(res.trace.finalComplete).toBe(true);
  });
});

describe("runTurn — fleet memory", () => {
  it("records a gotcha lesson when the turn had to be revised", async () => {
    const record = vi.fn();
    const fleetMemory = { record, recall: () => [], all: () => [] };
    mockJudge
      .mockResolvedValueOnce(verdict({ complete: false, findings: ["no test"] }))
      .mockResolvedValueOnce(verdict({ complete: true }));
    await runTurn({ prompt: "add x", cwd: "/x", fleetMemory });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0].kind).toBe("gotcha");
    expect(record.mock.calls[0]?.[0].weight).toBe("high");
  });

  it("records a routine-change lesson when files changed without revision", async () => {
    const record = vi.fn();
    const fleetMemory = { record, recall: () => [], all: () => [] };
    await runTurn({ prompt: "tweak x", cwd: "/x", fleetMemory });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0].kind).toBe("routine-change");
    expect(record.mock.calls[0]?.[0].files).toContain("src/x.ts");
  });

  it("records nothing when no files changed and no revision was needed", async () => {
    const record = vi.fn();
    const fleetMemory = { record, recall: () => [], all: () => [] };
    mockRun.mockImplementationOnce(async () => ({
      text: "explained",
      steps: 1,
      messages: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    await runTurn({ prompt: "explain x", cwd: "/x", fleetMemory });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("runTurn — guards", () => {
  it("throws MissingGatewayKeyError when no gateway key resolves", async () => {
    mockEnsure.mockReturnValue(null);
    await expect(runTurn({ prompt: "x", cwd: "/x" })).rejects.toBeInstanceOf(
      MissingGatewayKeyError,
    );
    expect(mockRun).not.toHaveBeenCalled();
  });
});
