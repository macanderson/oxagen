import { describe, expect, it, vi } from "vitest";
import { Pipeline, type PipelineCoordinator, type PipelineDeps } from "../state-machine.js";
import { formatPipelineLine, type PipelineLogEntry, type PipelineLogSink } from "../pipeline-logging.js";
import { GrepFallbackResolver } from "../context-fallback.js";
import type { UnifiedConfig } from "../unified-config.js";
import type { GraphResult } from "../context-fallback.js";
import type { AssistTools, JudgeInput, JudgeOutput, PromptEnhancerOutput, SurveyOutput } from "../types.js";
import type { RoutingDecision, RoutingTask, WorkerRequest, WorkerResult } from "../../orchestrator/index.js";
import type { Complexity } from "../../orchestrator/index.js";

/** A full unified config with per-test overrides. */
function makeConfig(over: Partial<UnifiedConfig["pipeline"]> = {}): UnifiedConfig {
  return {
    pipeline: {
      enabled: true,
      verifyWork: true,
      promptEnhancement: { enabled: true, minAcceptableScore: 0.7 },
      survey: { enabled: true, maxQuestions: 3, alwaysAllowFreeText: true, preferBestPracticeOverAsking: true },
      judge: { enabled: true, defaultModel: "openai-most-capable-coding-model", mustDifferFromWorker: true },
      plan: { minComplexity: "medium" },
      screenshots: { requireWhenScreenImpacted: true },
      ...over,
    },
    runtime: { coordinator: "on-device" },
    routing: { trivialMaxComplexity: "low", switchCostTokenBudget: 1500, defaultCodeWorker: "sonnet-5", cheapBasicWorker: "haiku" },
    graph: { enabled: true, endpoint: "http://localhost:0/graphrag", maxNodes: 200, fallbackToGrep: true },
    monitors: { askBeforeMonitoring: true, dispatchOnPullRequest: true, dispatchOnCiFix: true, pollIntervalSeconds: 30 },
    loop: { maxJudgeRetries: 2 },
  };
}

const CTX: GraphResult = {
  impactedFiles: [{ path: "apps/api/src/routes/v1/widgets.ts", reason: "defines the route" }],
  symbols: [],
  edges: [],
  coverage: 0.8,
};

function fakeContext(ctx: GraphResult = CTX) {
  return { query: vi.fn(async () => ctx), usedGraph: () => ctx.coverage >= 0.5 };
}

function fakeCoordinator(over: Partial<PipelineCoordinator> = {}): PipelineCoordinator {
  return {
    route: (_task: RoutingTask): RoutingDecision => ({
      model: "sonnet-5",
      isCoordinator: false,
      reason: "cheapest capable code worker",
      workerModelRecorded: "sonnet-5",
    }),
    dispatchWorker: async (_req: WorkerRequest): Promise<WorkerResult> => ({
      workerModel: "sonnet-5",
      diff: "diff --git a b\n+done",
      evidence: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.002,
    }),
    ...over,
  };
}

function fakeAssist(over: Partial<AssistTools> = {}): AssistTools {
  const enhanced: PromptEnhancerOutput = {
    enhancedPrompt: "Add a GET /v1/widgets route with tests",
    complexity: "medium",
    recommendedModel: "sonnet-5",
    addedContext: ["apps/api/src/routes/v1/widgets.ts"],
    rationale: "scoped by graph",
  };
  const pass: JudgeOutput = { verdict: "pass", score: 0.92, notes: "solid", gaps: [] };
  return {
    enhancePrompt: vi.fn(async () => enhanced),
    judge: vi.fn(async () => pass),
    survey: vi.fn(async (): Promise<SurveyOutput> => ({ answers: [] })),
    ...over,
  };
}

/** Build a pipeline with capturing logs + all collaborators faked. */
function harness(deps: Partial<PipelineDeps> = {}, cfg = makeConfig()) {
  const entries: PipelineLogEntry[] = [];
  const lines: string[] = [];
  const log = (e: PipelineLogEntry) => {
    entries.push(e);
    lines.push(formatPipelineLine(e));
  };
  // A real resolver wired to an injected graph client, so the [graph] line is
  // emitted into the same captured stream (source=graphrag on a hit).
  const graphResolver = (ctx: GraphResult, sink: PipelineLogSink) =>
    new GrepFallbackResolver({ graph: async () => ctx, log: sink });
  const pipeline = new Pipeline({
    coordinator: fakeCoordinator(),
    assist: fakeAssist(),
    context: graphResolver(CTX, log),
    config: cfg,
    log,
    // Deterministic: low score forces enhancement; medium complexity forces plan.
    scoreCompleteness: () => 0.4,
    estimateComplexity: () => "medium" as Complexity,
    ...deps,
  });
  return { pipeline, entries, lines };
}

describe("Pipeline (5-step state machine)", () => {
  it("runs the full flow and completes when the judge passes", async () => {
    const { pipeline, lines } = harness({ collectEvidence: async () => ["test.log"] });
    const result = await pipeline.run({ rawPrompt: "add a widgets route" });

    expect(result.taskComplete).toBe(true);
    expect(result.judge?.verdict).toBe("pass");
    expect(result.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
    // The debug stream contains the enhancer line AND the judge line (visibility).
    expect(lines.some((l) => l.includes("tool=prompt-enhancer") && l.includes("status=done"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=judge") && l.includes("status=done"))).toBe(true);
    // Graph-first context line is present.
    expect(lines.some((l) => l.startsWith("[graph]"))).toBe(true);
  });

  it("cannot complete without evidence when verifyWork is true", async () => {
    // Worker returns no evidence and the collector finds none.
    const { pipeline, lines } = harness({
      collectEvidence: async () => [],
    });
    const result = await pipeline.run({ rawPrompt: "add a widgets route" });

    expect(result.taskComplete).toBe(false);
    expect(result.evidence).toEqual([]);
    // Verify logged as not-done; the judge never ran.
    expect(lines.some((l) => l.includes("step=4") && l.includes("status=skipped"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=judge") && l.includes("status=done"))).toBe(false);
  });

  it("requires a screenshot when an impacted screen is reachable", async () => {
    const screenCtx: GraphResult = {
      impactedFiles: [{ path: "apps/app/src/components/widget.tsx", reason: "renders the widget" }],
      symbols: [],
      edges: [],
      coverage: 0.8,
    };
    // Evidence has a test log but no screenshot → not done.
    const noShot = harness({
      context: fakeContext(screenCtx),
      collectEvidence: async () => ["test.log"],
    });
    expect((await noShot.pipeline.run({ rawPrompt: "restyle the widget component" })).taskComplete).toBe(false);

    // Add a screenshot → done.
    const withShot = harness({
      context: fakeContext(screenCtx),
      collectEvidence: async () => ["test.log", "screenshot.png"],
    });
    expect((await withShot.pipeline.run({ rawPrompt: "restyle the widget component" })).taskComplete).toBe(true);
  });

  it("passes the judge a model different from the worker", async () => {
    const judge = vi.fn(async (_input: JudgeInput): Promise<JudgeOutput> => ({ verdict: "pass", score: 0.9, notes: "", gaps: [] }));
    const { pipeline } = harness({
      assist: fakeAssist({ judge }),
      collectEvidence: async () => ["test.log"],
    });
    await pipeline.run({ rawPrompt: "add a widgets route" });
    const call = judge.mock.calls[0]![0];
    expect(call.workerModel).toBe("sonnet-5");
    expect(call.judgeModel).toBe("openai-most-capable-coding-model");
    expect(call.judgeModel).not.toBe(call.workerModel);
  });

  it("runs the plan tool for complex work and scopes it to graph-impacted files", async () => {
    const { pipeline, lines } = harness(
      { collectEvidence: async () => ["test.log"], estimateComplexity: () => "high" as Complexity },
    );
    const result = await pipeline.run({ rawPrompt: "refactor the widget subsystem end to end" });
    expect(result.plan).toBeDefined();
    expect(result.plan!.tasks.some((t) => t.title.includes("widgets.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=plan") && l.includes("status=done"))).toBe(true);
  });

  it("skips the plan tool for below-minComplexity work", async () => {
    const { pipeline, lines } = harness({
      collectEvidence: async () => ["test.log"],
      estimateComplexity: () => "low" as Complexity,
      // low is trivial-ish; force enhancer off-path by high score so complexity stays 'low'
      scoreCompleteness: () => 0.9,
      clarificationSignals: () => ({ completenessScore: 0.9, recoverableFromContext: true }),
    });
    const result = await pipeline.run({ rawPrompt: "rename a local variable" });
    expect(result.plan).toBeUndefined();
    expect(lines.some((l) => l.includes("tool=plan"))).toBe(false);
  });

  it("with pipeline OFF, skips enhancer, survey, and judge — each logged", async () => {
    const cfg = makeConfig({ enabled: false });
    const { pipeline, lines } = harness({ collectEvidence: async () => ["test.log"] }, cfg);
    const result = await pipeline.run({ rawPrompt: "add a widgets route" });

    // Enhancer + survey + judge all skipped and logged.
    expect(lines.some((l) => l.includes("tool=prompt-enhancer") && l.includes("status=skipped") && l.includes("pipeline off"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=survey") && l.includes("status=skipped") && l.includes("pipeline off"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=judge") && l.includes("status=skipped"))).toBe(true);
    // No judge verdict ran; completion rests on verify (evidence present → complete).
    expect(result.judge?.notes).toContain("best-practice default");
    expect(result.taskComplete).toBe(true);
  });

  it("loops back to step 3 on a judge fail, then reports incomplete after retries", async () => {
    const judge = vi.fn(async () => ({ verdict: "fail" as const, score: 0.3, notes: "missing tests", gaps: ["tests"] }));
    const dispatchWorker = vi.fn(async (): Promise<WorkerResult> => ({
      workerModel: "sonnet-5",
      diff: "diff",
      evidence: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    }));
    const { pipeline } = harness({
      assist: fakeAssist({ judge }),
      coordinator: fakeCoordinator({ dispatchWorker }),
      collectEvidence: async () => ["test.log"],
    });
    const result = await pipeline.run({ rawPrompt: "add a widgets route" });
    expect(result.taskComplete).toBe(false);
    // maxJudgeRetries = 2 → 3 attempts.
    expect(dispatchWorker).toHaveBeenCalledTimes(3);
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it("dispatchMonitor delegates to the monitor service and never blocks", async () => {
    const dispatch = vi.fn(async () => ({ subagentId: "mon_1", background: true as const }));
    const { pipeline } = harness({ monitors: { dispatch, onReport: () => {} } });
    const r = await pipeline.dispatchMonitor({ targetType: "gh_actions_run", targetId: "999" });
    expect(r).toEqual({ subagentId: "mon_1", background: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("throws when dispatchMonitor has no monitor service wired", async () => {
    const { pipeline } = harness();
    await expect(pipeline.dispatchMonitor({ targetType: "ci_job", targetId: "1" })).rejects.toThrow(/monitor service/i);
  });

  it("runs end-to-end on the built-in default heuristics (no injected scorers)", async () => {
    const lines: string[] = [];
    const log = (e: PipelineLogEntry) => lines.push(formatPipelineLine(e));
    const pipeline = new Pipeline({
      coordinator: fakeCoordinator(),
      assist: fakeAssist(),
      context: new GrepFallbackResolver({ graph: async () => CTX, log }),
      config: makeConfig(),
      log,
      // No scoreCompleteness / estimateComplexity / clarificationSignals / writesCode /
      // screenImpacted — exercise the real defaults.
      collectEvidence: async () => ["test.log"],
    });
    const result = await pipeline.run({ rawPrompt: "add a new widgets route with validation and tests" });
    expect(result.taskComplete).toBe(true);
    expect(lines.some((l) => l.includes("tool=prompt-enhancer"))).toBe(true);
  });

  it("uses the default complexity estimate when the enhancer is off (pipeline disabled)", async () => {
    const lines: string[] = [];
    const log = (e: PipelineLogEntry) => lines.push(formatPipelineLine(e));
    const pipeline = new Pipeline({
      coordinator: fakeCoordinator(),
      assist: fakeAssist(),
      context: new GrepFallbackResolver({ graph: async () => CTX, log }),
      config: makeConfig({ enabled: false }),
      log,
      collectEvidence: async () => ["test.log"],
    });
    // A long prompt drives defaultComplexity high, so the plan tool runs even
    // with the enhancer/judge off.
    const longPrompt = Array.from({ length: 130 }, (_, i) => `word${i}`).join(" ");
    const result = await pipeline.run({ rawPrompt: longPrompt });
    expect(result.plan).toBeDefined();
    expect(result.taskComplete).toBe(true);
  });

  it("surveys when the gap is a real developer decision", async () => {
    const survey = vi.fn(async () => ({ answers: [{ questionId: "q1", value: "ship MVP", source: "free_text" as const }] }));
    const { pipeline, lines } = harness({
      assist: fakeAssist({ survey }),
      collectEvidence: async () => ["test.log"],
      // Not recoverable + no best practice → developer-decision → survey.
      clarificationSignals: () => ({ completenessScore: 0.4, recoverableFromContext: false, developerLikelyToAnswerWell: true }),
    });
    await pipeline.run({ rawPrompt: "build the thing the way we discussed" });
    expect(survey).toHaveBeenCalledOnce();
    expect(lines.some((l) => l.includes("tool=survey") && l.includes("status=done"))).toBe(true);
  });
});
