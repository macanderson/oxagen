/**
 * The 5-step pipeline state machine (Group 6, deliverable 1).
 *
 * This is where the whole flow runs as one state machine. The coordinator
 * (Group 2) drives routing and dispatch, the context layer feeds it (Group 3's
 * seam, grep fallback for now), the assist tools enhance and judge (Group 4),
 * and the monitors run long tasks in the background (Group 5). This group owns
 * the step order, the quality gate, verification, and the logs that prove it ran.
 *
 * The five steps, in order:
 *   1. Evaluate prompt completeness → enhance (recoverable) or survey (a real
 *      developer decision), or skip when already complete / pipeline off.
 *   2. Rate complexity and pick the model (cheapest capable, via the router).
 *   3. Do the work — complex work goes through the `plan` tool first.
 *   4. Qualify the work — when `verifyWork` is on, evidence is mandatory
 *      (a screenshot too when an impacted screen is reachable).
 *   5. Judge the work — on a different model than the worker; a `fail` loops
 *      back to step 3 with the notes, up to `loop.maxJudgeRetries` times.
 *
 * One switch controls the gate: when `pipeline.enabled` is false, the enhancer,
 * survey, and judge are all off and the agent runs on best-practice defaults —
 * every skip is logged. Every collaborator is injected, so the whole machine is
 * driven deterministically in tests with no model calls or network.
 */
import { complexityAtMost } from "../orchestrator/config.js";
import type {
  Complexity,
  RoutingDecision,
  RoutingTask,
  WorkerRequest,
  WorkerResult,
} from "../orchestrator/index.js";
import { estimateTokens } from "../runtime/tokens.js";
import { decideClarification, type ClarificationSignals } from "./decide.js";
import { assistTools } from "./tools.js";
import type {
  AssistTools,
  JudgeOutput,
  PromptEnhancerOutput,
  SurveyOutput,
} from "./types.js";
import { runPlan, type PlanOutput } from "./plan.js";
import { GrepFallbackResolver, type ContextResolver, type GraphResult } from "./context-fallback.js";
import type { MonitorDispatchInput, MonitorDispatchResult, MonitorService } from "../monitors/index.js";
import { defaultPipelineLogSink, type PipelineLogSink } from "./pipeline-logging.js";
import { loadUnifiedConfig, type UnifiedConfig } from "./unified-config.js";

/** The coordinator surface the pipeline drives (Group 2's `Orchestrator` fits). */
export interface PipelineCoordinator {
  route(task: RoutingTask): RoutingDecision;
  dispatchWorker(req: WorkerRequest): Promise<WorkerResult>;
}

/** A single step's outcome. */
export interface StepResult {
  step: 1 | 2 | 3 | 4 | 5;
  status: "done" | "skipped" | "looped";
  detail: string;
}

/** Input to a pipeline run. */
export interface PipelineRunInput {
  rawPrompt: string;
}

/** The result of a full pipeline run. */
export interface PipelineRunResult {
  steps: StepResult[];
  /** True only after the judge passes (or, with the judge off, after verify). */
  taskComplete: boolean;
  judge?: JudgeOutput;
  decision?: RoutingDecision;
  worker?: WorkerResult;
  evidence: string[];
  plan?: PlanOutput;
}

/** Injectable heuristics + collaborators for the {@link Pipeline}. */
export interface PipelineDeps {
  coordinator: PipelineCoordinator;
  assist?: AssistTools;
  context?: ContextResolver;
  monitors?: MonitorService;
  config?: UnifiedConfig;
  log?: PipelineLogSink;
  /** 0..1 prompt-completeness scorer. Default: length + context heuristic. */
  scoreCompleteness?: (rawPrompt: string, ctx: GraphResult) => number;
  /** Complexity estimate used when the enhancer does not run. */
  estimateComplexity?: (rawPrompt: string, ctx: GraphResult) => Complexity;
  /** Ask-vs-guess signal builder feeding {@link decideClarification}. */
  clarificationSignals?: (rawPrompt: string, score: number, ctx: GraphResult) => ClarificationSignals;
  /** Does the task write/edit code? Feeds routing. Default: keyword heuristic. */
  writesCode?: (rawPrompt: string) => boolean;
  /** Collect proof-of-done for a worker result. Default: the worker's own evidence. */
  collectEvidence?: (result: WorkerResult) => Promise<string[]>;
  /** Is an impacted screen reachable (→ a screenshot is required)? */
  screenImpacted?: (ctx: GraphResult) => boolean;
  /** Optional per-worker-call timeout, threaded to dispatch. */
  workerTimeoutMs?: number;
}

/** Mutable per-run state, reset on every {@link Pipeline.run}. */
interface RunState {
  rawPrompt: string;
  context: GraphResult;
  enhancedPrompt: string;
  complexity: Complexity;
  decision?: RoutingDecision;
  worker?: WorkerResult;
  evidence: string[];
  plan?: PlanOutput;
}

const DEFAULT_SCREEN_RE = /\.(tsx|jsx|vue|svelte|html)$/i;
const CODE_INTENT_RE =
  /\b(add|fix|implement|refactor|edit|create|write|rename|delete|migrate|route|handler|function|component|bug|test|build)\b/i;
const QUESTION_RE = /\b(what|why|how|explain|describe|list|show|when|where|which)\b/i;

/** The default, config-driven pipeline. */
export class Pipeline {
  private readonly deps: PipelineDeps;
  private readonly config: UnifiedConfig;
  private readonly log: PipelineLogSink;
  private readonly assist: AssistTools;
  private readonly context: ContextResolver;
  private state: RunState | null = null;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.config = deps.config ?? loadUnifiedConfig();
    this.log = deps.log ?? defaultPipelineLogSink;
    this.assist = deps.assist ?? assistTools;
    this.context = deps.context ?? new GrepFallbackResolver({ log: this.log });
  }

  /** The active run state; throws if a step is called before {@link run}/{@link evaluatePrompt}. */
  private requireState(): RunState {
    if (!this.state) throw new Error("Pipeline step called before evaluatePrompt() started the run.");
    return this.state;
  }

  // ── Step 1 — evaluate prompt completeness ──────────────────────────────────
  async evaluatePrompt(
    input: PipelineRunInput,
  ): Promise<PromptEnhancerOutput | SurveyOutput | null> {
    // Graph first: gather context before scoring (this logs the [graph] line).
    const context = await this.context.query({ query: input.rawPrompt });
    const score = (this.deps.scoreCompleteness ?? defaultScore)(input.rawPrompt, context);
    this.state = {
      rawPrompt: input.rawPrompt,
      context,
      enhancedPrompt: input.rawPrompt,
      complexity: (this.deps.estimateComplexity ?? defaultComplexity)(input.rawPrompt, context),
      evidence: [],
    };

    // One switch off: no enhancer, no survey — best-practice defaults, logged.
    if (!this.config.pipeline.enabled) {
      this.log({ kind: "step", step: 1, label: "tool=prompt-enhancer", status: "skipped", fields: [["reason", "pipeline off"]] });
      this.log({ kind: "step", step: 1, label: "tool=survey", status: "skipped", fields: [["reason", "pipeline off"]] });
      return null;
    }

    const threshold = this.config.pipeline.promptEnhancement.minAcceptableScore;
    const signals =
      (this.deps.clarificationSignals ?? defaultSignals)(input.rawPrompt, score, context);
    const decision = await decideClarification({ ...signals, threshold });

    if (decision.kind === "skip") {
      this.log({ kind: "step", step: 1, label: "tool=prompt-enhancer", status: "skipped", fields: [["reason", "already-complete"]] });
      return null;
    }

    // A real developer decision the context can't recover → ask first.
    let survey: SurveyOutput | undefined;
    if (decision.kind === "survey" && this.config.pipeline.survey.enabled) {
      this.log({ kind: "step", step: 1, label: "tool=survey", status: "start", fields: [["reason", "developer-decision"]] });
      survey = await this.assist.survey({
        reason: "The gap is a decision the developer owns and context cannot recover.",
        questions: [],
      });
      this.log({ kind: "step", step: 1, label: "tool=survey", status: "done", fields: [["answers", survey.answers.length]] });
    }

    // Enhance the prompt (folding in any survey answers via the enhancer's context).
    this.log({ kind: "step", step: 1, label: "tool=prompt-enhancer", status: "start", fields: [["reason", `completeness ${round2(score)} < ${threshold}`]] });
    const enhanced = await this.assist.enhancePrompt({
      rawPrompt: input.rawPrompt,
      completenessScore: score,
      graphContext: {
        impactedFiles: context.impactedFiles,
        symbols: context.symbols,
        coverage: context.coverage,
      },
    });
    this.log({ kind: "step", step: 1, label: "tool=prompt-enhancer", status: "done", fields: [["complexity", enhanced.complexity], ["recommend_model", enhanced.recommendedModel]] });

    const state = this.requireState();
    state.enhancedPrompt = enhanced.enhancedPrompt;
    state.complexity = enhanced.complexity;
    return survey ?? enhanced;
  }

  // ── Step 2 — rate complexity and pick the model ────────────────────────────
  selectModel(): RoutingDecision {
    const state = this.requireState();
    const task: RoutingTask = {
      complexity: state.complexity,
      writesCode: (this.deps.writesCode ?? defaultWritesCode)(state.rawPrompt),
      promptTokens: estimateTokens(state.enhancedPrompt),
    };
    const decision = this.deps.coordinator.route(task); // logs [route]
    state.decision = decision;
    return decision;
  }

  // ── Step 3 — do the work (plan first when complex) ─────────────────────────
  async doWork(plan?: PlanOutput): Promise<WorkerResult> {
    const state = this.requireState();
    const decision = state.decision ?? this.selectModel();

    // Complex work is planned first, and the coordinator manages the task list.
    let planOutput = plan;
    const needsPlan = !complexityAtMost(state.complexity, prevComplexity(this.config.pipeline.plan.minComplexity));
    if (!planOutput && needsPlan) {
      planOutput = await runPlan(
        {
          objective: state.rawPrompt,
          enhancedPrompt: state.enhancedPrompt,
          graphImpactedFiles: state.context.impactedFiles.map((f) => f.path),
        },
        this.log,
      );
      state.plan = planOutput;
    }

    const req: WorkerRequest = {
      model: decision.model,
      prompt: state.enhancedPrompt,
      context: state.context,
      ...(this.deps.workerTimeoutMs !== undefined ? { timeoutMs: this.deps.workerTimeoutMs } : {}),
    };
    const worker = await this.deps.coordinator.dispatchWorker(req); // logs [dispatch]
    state.worker = worker;
    return worker;
  }

  // ── Step 4 — qualify the work (definition of done) ─────────────────────────
  async qualify(result: WorkerResult): Promise<{ ok: boolean; evidence: string[] }> {
    const state = this.requireState();
    const evidence = await (this.deps.collectEvidence ?? defaultEvidence)(result);
    state.evidence = evidence;

    if (!this.config.pipeline.verifyWork) {
      this.log({ kind: "step", step: 4, label: "verify", status: "skipped", fields: [["reason", "verifyWork off"]] });
      return { ok: true, evidence };
    }

    const hasEvidence = evidence.length > 0;
    const screenImpacted = (this.deps.screenImpacted ?? defaultScreenImpacted)(state.context);
    const needsShot =
      this.config.pipeline.screenshots.requireWhenScreenImpacted && screenImpacted;
    const hasShot = evidence.some((e) => /\.png$|\.jpe?g$|screenshot/i.test(e));
    const ok = hasEvidence && (!needsShot || hasShot);

    this.log({
      kind: "step",
      step: 4,
      label: "verify",
      status: ok ? "done" : "skipped",
      fields: [
        ["evidence", `[${evidence.join(", ")}]`],
        ...(needsShot ? ([["screenshot_required", hasShot ? "present" : "missing"]] as [string, string][]) : []),
      ],
    });
    return { ok, evidence };
  }

  // ── Step 5 — judge (quality gate; different model than the worker) ──────────
  async gate(result: WorkerResult): Promise<JudgeOutput> {
    const state = this.requireState();
    const judgeCfg = this.config.pipeline.judge;

    if (!this.config.pipeline.enabled || !judgeCfg.enabled) {
      this.log({ kind: "step", step: 5, label: "tool=judge", status: "skipped", fields: [["reason", this.config.pipeline.enabled ? "judge off" : "pipeline off"]] });
      return { verdict: "pass", score: 1, notes: "judge disabled — best-practice default", gaps: [] };
    }

    // The judge MUST differ from the worker (the router never routes work to the
    // judge model, so this holds; `assist.judge` enforces it and throws otherwise).
    const judgeModel = judgeCfg.defaultModel;
    this.log({
      kind: "step",
      step: 5,
      label: "tool=judge",
      status: "start",
      fields: [["worker_model", result.workerModel], ["judge_model", judgeModel]],
    });
    const verdict = await this.assist.judge({
      diff: result.diff,
      evidence: state.evidence,
      definitionOfDone: state.rawPrompt,
      workerModel: result.workerModel,
      judgeModel,
    });
    this.log({
      kind: "step",
      step: 5,
      label: "tool=judge",
      status: "done",
      fields: [["verdict", verdict.verdict], ["score", round2(verdict.score)]],
    });
    return verdict;
  }

  // ── Dispatch a background monitor (never blocks) ───────────────────────────
  async dispatchMonitor(input: MonitorDispatchInput): Promise<MonitorDispatchResult> {
    if (!this.deps.monitors) {
      throw new Error("No monitor service wired into the pipeline (Group 5).");
    }
    return this.deps.monitors.dispatch(input); // logs [monitor]
  }

  // ── Run all five steps and enforce the gate ────────────────────────────────
  async run(input: PipelineRunInput): Promise<PipelineRunResult> {
    const steps: StepResult[] = [];

    const step1 = await this.evaluatePrompt(input);
    steps.push({ step: 1, status: step1 ? "done" : "skipped", detail: step1 ? "prompt closed the gap" : "no enhancement needed" });

    const decision = this.selectModel();
    steps.push({ step: 2, status: "done", detail: `selected ${decision.model} (coordinator=${decision.isCoordinator})` });

    const state = this.requireState();
    let judge: JudgeOutput | undefined;
    let taskComplete = false;

    const maxAttempts = this.config.loop.maxJudgeRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const worker = await this.doWork(state.plan);
      steps.push({ step: 3, status: attempt > 1 ? "looped" : "done", detail: `attempt ${attempt}: worker ${worker.workerModel}` });

      const { ok } = await this.qualify(worker);
      steps.push({ step: 4, status: ok ? "done" : "skipped", detail: ok ? `evidence: ${state.evidence.length}` : "no evidence — not done" });
      if (!ok) {
        // Verify gate failed (no evidence): the work is not done; do not judge.
        taskComplete = false;
        break;
      }

      judge = await this.gate(worker);
      const judgeRan = this.config.pipeline.enabled && this.config.pipeline.judge.enabled;
      steps.push({ step: 5, status: judgeRan ? "done" : "skipped", detail: judgeRan ? `verdict ${judge.verdict} (${round2(judge.score)})` : "judge off" });

      if (!judgeRan) {
        taskComplete = true; // gate off → completion rests on verify (already ok)
        break;
      }
      if (judge.verdict === "pass") {
        taskComplete = true;
        break;
      }
      // Fail → loop back to step 3 with the notes, unless out of attempts.
    }

    return {
      steps,
      taskComplete,
      ...(judge ? { judge } : {}),
      ...(state.decision ? { decision: state.decision } : {}),
      ...(state.worker ? { worker: state.worker } : {}),
      evidence: state.evidence,
      ...(state.plan ? { plan: state.plan } : {}),
    };
  }
}

// ── Default heuristics (all injectable for determinism) ──────────────────────

function defaultScore(rawPrompt: string, ctx: GraphResult): number {
  const words = rawPrompt.trim().split(/\s+/).filter(Boolean).length;
  return round2(Math.min(1, words / 40 + (ctx.coverage > 0 ? 0.2 : 0)));
}

function defaultComplexity(rawPrompt: string, ctx: GraphResult): Complexity {
  const words = rawPrompt.trim().split(/\s+/).filter(Boolean).length;
  const files = ctx.impactedFiles.length;
  if (files > 10 || words > 120) return "high";
  if (files > 3 || words > 40) return "medium";
  if (words > 8) return "low";
  return "trivial";
}

function defaultSignals(_rawPrompt: string, score: number, ctx: GraphResult): ClarificationSignals {
  return {
    completenessScore: score,
    recoverableFromContext: ctx.impactedFiles.length > 0 || ctx.coverage > 0,
    developerLikelyToAnswerWell: true,
    fallbackDefault: "follow the applicable best practice",
  };
}

function defaultWritesCode(rawPrompt: string): boolean {
  if (CODE_INTENT_RE.test(rawPrompt)) return true;
  if (QUESTION_RE.test(rawPrompt)) return false;
  return true; // a coding agent's default is that work touches code
}

const defaultEvidence = async (result: WorkerResult): Promise<string[]> => result.evidence;

function defaultScreenImpacted(ctx: GraphResult): boolean {
  return ctx.impactedFiles.some(
    (f) => DEFAULT_SCREEN_RE.test(f.path) || /(^|\/)(components?|app|pages)\//i.test(f.path),
  );
}

/** The complexity one rank below `c` — so "at or above `c`" is `!atMost(complexity, prev)`. */
function prevComplexity(c: Complexity): Complexity {
  const scale: Complexity[] = ["trivial", "low", "medium", "high", "very_high"];
  const i = scale.indexOf(c);
  return i <= 0 ? "trivial" : scale[i - 1]!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
