/**
 * Orchestrator + router domain types (Group 2 — coordinator and model routing).
 *
 * These mirror the Group 7 typed contracts (`contracts/router.ts`,
 * `contracts/orchestrator.ts`, and the tool/context/monitor slices the
 * coordinator calls). They are re-declared here — rather than imported from a
 * `contracts` package that has not landed yet — so Group 2 is self-contained and
 * type-checks on its own. When Group 7's contracts land, these become the
 * concrete implementations behind those interfaces with no shape drift.
 *
 * The router and coordinator stay framework-free: they consume Group 1's
 * {@link import("../runtime/index.js").ModelProvider} and the model registry, and
 * they call Groups 3/4/5 through the collaborator interfaces below, which are
 * injected. Nothing here reaches for Ink, the AI SDK, or the network directly.
 */

/** Ordered task-complexity scale. Mirrors `routing-policy.json -> complexityScale`. */
export type Complexity = "trivial" | "low" | "medium" | "high" | "very_high";

// ── Router (contracts/router.ts) ─────────────────────────────────────────────

/** A unit of work to route. Prompt length feeds the switch-cost calculation. */
export interface RoutingTask {
  complexity: Complexity;
  /** True when the task writes or edits code — code work has a Sonnet-5 floor. */
  writesCode: boolean;
  /** Estimated prompt length in tokens; a longer prompt raises switch cost. */
  promptTokens: number;
  /** Optional 0..1 weight for whether paying a switch is worth it. */
  taskValue?: number;
}

/** The router's decision for one task. */
export interface RoutingDecision {
  /** The selected model id (coordinator id, or a worker registry id). */
  model: string;
  /** True when kept on the coordinator (trivial work, no dispatch). */
  isCoordinator: boolean;
  /** Human-readable justification, surfaced in the debug log. */
  reason: string;
  /**
   * The worker model chosen, or null when kept on the coordinator. Handed to the
   * judge (Group 6) so it can be forced to a *different* model than the worker.
   */
  workerModelRecorded: string | null;
}

/** The router contract: cheapest capable model, switch-cost and length aware. */
export interface Router {
  /**
   * Returns the cheapest capable model. Keeps trivial work on the coordinator.
   * Above trivial, dispatches to a worker (code work defaults to Sonnet 5).
   */
  route(task: RoutingTask): RoutingDecision;
  /** Estimated token cost of switching models mid-turn (context re-send). */
  estimateSwitchCost(fromModel: string, toModel: string, promptTokens: number): number;
}

/**
 * One priced, capability-ranked worker candidate. The router ranks by `cost`
 * (cheapest first) and gates by `quality` against the complexity's requirement.
 */
export interface WorkerTier {
  /** Registry id (e.g. "haiku", "sonnet-5", "opus"). */
  id: string;
  /** 0..1 code-quality ranking used to gate capability. Higher is stronger. */
  quality: number;
  /**
   * Relative cost weight (cheapest first). Derived from the rate card's
   * output price, which dominates coding-agent spend.
   */
  cost: number;
}

// ── Collaborator tools the coordinator calls (Groups 3/4/5) ───────────────────
//
// Minimal mirrors of the Group 7 contract slices the coordinator depends on.
// Injected into the {@link Orchestrator}; Group 2 ships no real implementations
// (those are Groups 3/4/5), only the seams and the enforcement around them.

/** Group 3 — structured graph context input. */
export interface GraphQueryInput {
  query: string;
  focusSymbols?: string[];
  maxNodes?: number;
}

/** Group 3 — a file the change is expected to touch. */
export interface ImpactedFile {
  path: string;
  reason: string;
  rank?: number;
}

/** Group 3 — structured graph result. `coverage` gates the grep fallback. */
export interface GraphResult {
  impactedFiles: ImpactedFile[];
  symbols: { name: string; file: string; line?: number }[];
  edges: { from: string; to: string; type: string }[];
  /** 0..1. Below the Group 3 threshold, the resolver falls back to grep. */
  coverage: number;
}

/** Group 3 — the context resolver (graph before grep). */
export interface ContextResolver {
  query(input: GraphQueryInput): Promise<GraphResult>;
}

/** Group 4/6 — judge request. `judgeModel` MUST differ from `workerModel`. */
export interface JudgeInput {
  diff: string;
  evidence?: string[];
  definitionOfDone?: string;
  workerModel: string;
  judgeModel: string;
}

/** Group 4/6 — judge verdict. */
export interface JudgeOutput {
  verdict: "pass" | "fail";
  score: number;
  notes: string;
  gaps?: string[];
}

/** Group 4/6 — the judge tool. Throws if `judgeModel === workerModel`. */
export interface JudgeTool {
  judge(input: JudgeInput): Promise<JudgeOutput>;
}

/** Group 5 — background-monitor dispatch input. */
export interface MonitorDispatchInput {
  targetType: "gh_actions_run" | "pull_request" | "ci_job";
  targetId: string;
  committedChangeRefs?: string[];
  pollIntervalSeconds?: number;
}

/** Group 5 — dispatch result. Always background; returns control immediately. */
export interface MonitorDispatchResult {
  subagentId: string;
  background: true;
}

/** Group 5 — the monitor service. Dispatches without blocking the turn. */
export interface MonitorService {
  dispatch(input: MonitorDispatchInput): Promise<MonitorDispatchResult>;
}

// ── Orchestrator (contracts/orchestrator.ts) ──────────────────────────────────

/** A worker dispatch request assembled by the coordinator. */
export interface WorkerRequest {
  /** The model id from {@link RoutingDecision}. */
  model: string;
  /** The (optionally enhanced) prompt. */
  prompt: string;
  /** Structured graph context to hand the worker. */
  context?: GraphResult;
  /** Per-call timeout in milliseconds (Group 8 moves timeouts to the model call). */
  timeoutMs?: number;
}

/** The result of a worker run, with the worker model id recorded for the judge. */
export interface WorkerResult {
  /** The concrete worker model that produced the output — recorded for the judge. */
  workerModel: string;
  /** The worker's output (a diff, or free text for non-code work). */
  diff: string;
  /** Proof-of-done collected during the work (test/build logs, files, etc.). */
  evidence: string[];
  /** Token accounting for the dispatch. */
  usage: { inputTokens: number; outputTokens: number };
  /** Estimated USD cost of the dispatch. */
  costUsd: number;
}

/**
 * The primary agent — a coordinator. It gathers context, routes, dispatches
 * workers, requests judge feedback, verifies work, and dispatches monitors. It
 * has no method to write non-trivial code itself, by design.
 */
export interface Coordinator {
  gatherContext(input: GraphQueryInput): Promise<GraphResult>;
  route(task: RoutingTask): RoutingDecision;
  dispatchWorker(req: WorkerRequest): Promise<WorkerResult>;
  requestJudge(input: JudgeInput): Promise<JudgeOutput>;
  verifyWork(result: WorkerResult): Promise<boolean>;
  dispatchMonitor(input: MonitorDispatchInput): Promise<MonitorDispatchResult>;
  /** Trivial work only. Throws when asked to do work above trivial complexity. */
  doTrivial(task: string, complexity?: Complexity): Promise<string>;
}
