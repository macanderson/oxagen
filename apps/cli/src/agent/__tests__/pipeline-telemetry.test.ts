/**
 * Pipeline verbose telemetry — proves that with `verbose: true` the trace carries
 * a PhaseStat per phase (with the model + token/cost attributable to each), the
 * tool events the loop surfaced, the enhancer's context-gather detail, and that a
 * non-verbose turn stays lean (no phases / toolEvents). The stage modules are
 * mocked, so no gateway or filesystem is touched.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { PromptEvaluation, JudgeVerdict, ToolEvent } from "../trace.js";

vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));
vi.mock("../env.js", () => {
  class MissingGatewayKeyError extends Error {}
  return { ensureGatewayKey: vi.fn(() => "key"), MissingGatewayKeyError };
});
vi.mock("../loop.js", () => ({ runAgent: vi.fn() }));
vi.mock("../evaluator.js", () => ({ evaluatePrompt: vi.fn() }));
vi.mock("../judge.js", () => ({
  judgeCompleteness: vi.fn(),
  buildRevisionPrompt: vi.fn(() => "REVISION PROMPT"),
}));
vi.mock("../prompt-enhancer.js", () => ({ enhancePrompt: vi.fn() }));

import { runTurn } from "../pipeline.js";
import { runAgent } from "../loop.js";
import { evaluatePrompt } from "../evaluator.js";
import { judgeCompleteness } from "../judge.js";
import { enhancePrompt } from "../prompt-enhancer.js";

const mockRun = runAgent as unknown as Mock;
const mockEval = evaluatePrompt as unknown as Mock;
const mockJudge = judgeCompleteness as unknown as Mock;
const mockEnhance = enhancePrompt as unknown as Mock;

function evaluation(over: Partial<PromptEvaluation> = {}): PromptEvaluation {
  return {
    completeness: 70, complexity: 50, recommendedTier: "balanced", missing: [], contextQueries: [],
    refinedPrompt: "refined ask", removed: [], reasoning: "r", fallback: false,
    model: "anthropic/claude-haiku-4.5", usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
    ...over,
  };
}
function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    complete: true, confidence: 90, findings: [], remainingWork: [], reasoning: "done",
    model: "anthropic/claude-opus-4.8", fallback: false,
    usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.002 }, ...over,
  };
}

beforeEach(() => {
  delete process.env["OXAGEN_LLM_BALANCED"];
  mockEval.mockResolvedValue(evaluation());
  mockEnhance.mockResolvedValue({
    prompt: "refined ask\n\n## context",
    context: "## context",
    resolved: ["Foo"],
    lessons: [],
    startedAt: 1000,
    finishedAt: 1040,
    durationMs: 40,
    retrieval: { symbolsQueried: ["Foo", "Bar"], pathsQueried: [], resolved: ["Foo"], unresolved: ["Bar"] },
  });
  mockJudge.mockResolvedValue(verdict());
  // Executor fires a tool event (so verbose capture has something to record).
  mockRun.mockImplementation(async (opts: Record<string, unknown>) => {
    (opts.onToolCall as (n: string, i: unknown) => void)?.("write_file", { path: "src/x.ts" });
    (opts.onToolEvent as ((e: ToolEvent) => void) | undefined)?.({
      name: "write_file",
      input: '{"path":"src/x.ts"}',
      result: "ok",
      startedAt: 2000,
      finishedAt: 2120,
      durationMs: 120,
      ok: true,
    });
    return {
      text: "done",
      steps: 2,
      messages: [{ role: "assistant", content: "done" }],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  });
});

describe("verbose telemetry", () => {
  it("records a per-phase breakdown with model + cost, plus tool events", async () => {
    const t = (await runTurn({ prompt: "fix Foo", cwd: "/x", verbose: true })).trace;

    expect(t.verbose).toBe(true);
    const phaseKinds = (t.phases ?? []).map((p) => p.phase);
    expect(phaseKinds).toEqual(["evaluate", "enhance", "route", "execute", "judge"]);

    // Each LLM phase is attributed to the model that ran it, with its own cost.
    const evalPhase = t.phases?.find((p) => p.phase === "evaluate");
    const execPhase = t.phases?.find((p) => p.phase === "execute");
    const judgePhase = t.phases?.find((p) => p.phase === "judge");
    expect(evalPhase?.model).toContain("haiku");
    expect(execPhase?.model).toContain("sonnet");
    expect(execPhase?.usage.inputTokens).toBe(100);
    expect(execPhase?.usage.costUsd).toBeGreaterThan(0);
    expect(judgePhase?.model).toContain("opus");
    // Non-LLM phases carry no model and zero cost.
    expect(t.phases?.find((p) => p.phase === "enhance")?.model).toBeUndefined();

    // Tool events captured with result + timing.
    expect(t.toolEvents).toHaveLength(1);
    expect(t.toolEvents?.[0]).toMatchObject({ name: "write_file", result: "ok", ok: true });

    // Context-gather detail threaded from the enhancer.
    expect(t.enhancement.durationMs).toBe(40);
    expect(t.enhancement.retrieval?.unresolved).toEqual(["Bar"]);

    // Phase costs sum to (approximately) the turn total.
    const phaseCost = (t.phases ?? []).reduce((s, p) => s + p.usage.costUsd, 0);
    expect(phaseCost).toBeCloseTo(t.usage.costUsd);
  });

  it("adds an execute+judge phase per revise round", async () => {
    mockJudge
      .mockResolvedValueOnce(verdict({ complete: false, findings: ["no test"] }))
      .mockResolvedValueOnce(verdict({ complete: true }));

    const t = (await runTurn({ prompt: "add x", cwd: "/x", verbose: true, maxReviseRounds: 1 })).trace;
    const execs = (t.phases ?? []).filter((p) => p.phase === "execute");
    const judges = (t.phases ?? []).filter((p) => p.phase === "judge");
    expect(execs).toHaveLength(2);
    expect(judges).toHaveLength(2);
    expect(execs[0]?.round).toBe(0);
    expect(execs[1]?.round).toBe(1);
  });

  it("stays lean when verbose is off (no phases / toolEvents)", async () => {
    const t = (await runTurn({ prompt: "fix Foo", cwd: "/x" })).trace;
    expect(t.verbose).toBeUndefined();
    expect(t.phases).toBeUndefined();
    expect(t.toolEvents).toBeUndefined();
  });
});
