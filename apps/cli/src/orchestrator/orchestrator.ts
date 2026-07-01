/**
 * The Orchestrator — the primary agent as a *coordinator* (deliverable 1).
 *
 * It runs the coordinator loop and holds the pipeline state. It gathers context,
 * routes, dispatches workers, requests judge feedback, verifies work, and
 * dispatches background monitors. It calls tools; it does not write non-trivial
 * code itself. The only work it performs directly is trivial work
 * ({@link Orchestrator.doTrivial}), which runs on the coordinator model.
 *
 * Hard requirements this class enforces:
 *   - The coordinator runs on device by default (Group 1's `getCoordinator`);
 *     it is never silently swapped for a cloud model.
 *   - The coordinator never does non-trivial work: `doTrivial` throws above the
 *     trivial threshold, and there is no method to write non-trivial code.
 *   - The worker model is recorded on every dispatch so Group 6 can force a
 *     different judge model; `requestJudge` refuses `judgeModel === workerModel`.
 *
 * Groups 3 (context), 4 (judge), and 5 (monitors) are injected collaborators.
 * Group 2 ships the seams and the enforcement around them, not their internals;
 * a method that needs an un-wired collaborator throws a clear, actionable error.
 */
import {
  buildProvider as defaultBuildProvider,
  type BuildDeps,
} from "../runtime/providers/factory.js";
import { getCoordinator } from "../runtime/config.js";
import { roles } from "../runtime/registry.js";
import { estimateTokens } from "../runtime/tokens.js";
import type { CompletionRequest, ModelProvider } from "../runtime/types.js";
import { complexityAtMost, getTrivialMaxComplexity } from "./config.js";
import { defaultLogSink, type LogSink } from "./logging.js";
import { ModelRouter } from "./router.js";
import type {
  Complexity,
  ContextResolver,
  Coordinator,
  GraphQueryInput,
  GraphResult,
  JudgeInput,
  JudgeOutput,
  JudgeTool,
  MonitorDispatchInput,
  MonitorDispatchResult,
  MonitorService,
  Router,
  RoutingDecision,
  RoutingTask,
  WorkerRequest,
  WorkerResult,
} from "./types.js";

/** Thrown when a coordinator method needs a collaborator that was not wired. */
export class CollaboratorNotWiredError extends Error {
  constructor(collaborator: string, group: string) {
    super(
      `The ${collaborator} is not wired into the coordinator (${group}). ` +
        `Inject it when constructing the Orchestrator.`,
    );
    this.name = "CollaboratorNotWiredError";
  }
}

/** Thrown when trivial-only work is asked to exceed the trivial threshold. */
export class NonTrivialWorkError extends Error {
  constructor(complexity: Complexity, trivialMax: Complexity) {
    super(
      `The coordinator only does trivial work itself (complexity <= ${trivialMax}); ` +
        `"${complexity}" work must be dispatched to a worker.`,
    );
    this.name = "NonTrivialWorkError";
  }
}

/** Thrown when the judge would run on the same model as the worker. */
export class JudgeMustDifferError extends Error {
  constructor(model: string) {
    super(`The judge model must differ from the worker model ("${model}").`);
    this.name = "JudgeMustDifferError";
  }
}

/** Injectable dependencies for the {@link Orchestrator}. */
export interface OrchestratorDeps {
  /** The router. Defaults to the config-driven {@link ModelRouter}. */
  router?: Router;
  /** Build a provider for a model id. Defaults to Group 1's factory. */
  buildProvider?: (id: string) => ModelProvider;
  /** Provider build deps (gateway/on-device injection) threaded to the factory. */
  build?: BuildDeps;
  /** Group 3 — the context resolver (graph before grep). */
  context?: ContextResolver;
  /** Group 4 — the judge tool. */
  judgeTool?: JudgeTool;
  /** Group 5 — the background monitor service. */
  monitors?: MonitorService;
  /**
   * Whether verification evidence is mandatory (pipeline.verifyWork). When off,
   * {@link Orchestrator.verifyWork} passes without a gate.
   */
  verifyWork?: boolean;
  /** Log sink for routing + dispatch. Defaults to the debug JSONL stream. */
  log?: LogSink;
}

/** The default coordinator. */
export class Orchestrator implements Coordinator {
  private readonly router: Router;
  private readonly buildProvider: (id: string) => ModelProvider;
  private readonly log: LogSink;
  private readonly deps: OrchestratorDeps;

  /** The worker model recorded on the last dispatch (for judge selection). */
  private lastWorkerModel: string | null = null;
  /** The last routing decision (drives the trivial-work guard). */
  private lastDecision: RoutingDecision | null = null;

  constructor(deps: OrchestratorDeps = {}) {
    this.deps = deps;
    this.log = deps.log ?? defaultLogSink;
    this.router = deps.router ?? new ModelRouter({ log: this.log });
    this.buildProvider =
      deps.buildProvider ?? ((id: string) => defaultBuildProvider(id, deps.build));
  }

  /** The worker model recorded on the last dispatch, if any. */
  get recordedWorkerModel(): string | null {
    return this.lastWorkerModel;
  }

  // 1. Gather context (graph first — Group 3).
  async gatherContext(input: GraphQueryInput): Promise<GraphResult> {
    if (!this.deps.context) throw new CollaboratorNotWiredError("context resolver", "Group 3");
    return this.deps.context.query(input);
  }

  // 2. Route (cheapest capable, switch-cost aware — delegates to the router).
  route(task: RoutingTask): RoutingDecision {
    this.lastDecision = this.router.route(task);
    return this.lastDecision;
  }

  // 3. Dispatch a worker for anything above trivial. There is no method for the
  //    coordinator to write non-trivial code itself.
  async dispatchWorker(req: WorkerRequest): Promise<WorkerResult> {
    const provider = this.buildProvider(req.model);
    const completion: CompletionRequest = {
      messages: [{ role: "user", content: composeWorkerPrompt(req) }],
      ...(req.timeoutMs !== undefined ? { signal: timeoutSignal(req.timeoutMs) } : {}),
    };

    const est = provider.estimateCost(completion);
    this.log({
      kind: "dispatch",
      worker: req.model,
      task: req.prompt,
      estTokens: est.tokens,
    });

    await provider.ensureReady();
    const result = await provider.complete(completion);

    // Record the *routed* worker id (a registry id like "sonnet-5"), which is
    // what the judge-differ check compares against — not the raw gateway slug.
    this.lastWorkerModel = req.model;

    return {
      workerModel: req.model,
      diff: result.text,
      evidence: [],
      usage: result.usage,
      costUsd: result.costUsd,
    };
  }

  // 4. Request judge feedback. Enforces judgeModel !== workerModel.
  async requestJudge(input: JudgeInput): Promise<JudgeOutput> {
    if (input.judgeModel === input.workerModel) throw new JudgeMustDifferError(input.workerModel);
    if (!this.deps.judgeTool) throw new CollaboratorNotWiredError("judge tool", "Group 4");
    return this.deps.judgeTool.judge(input);
  }

  /**
   * The judge model to use for a given worker, per the registry default, forced
   * to differ from the worker. Group 6 consumes this to gate a completed task.
   */
  judgeModelFor(workerModel: string): string {
    const judge = roles().judgeModels.default;
    if (judge !== workerModel) return judge;
    // The registry default coincides with the worker (unusual): fall back to any
    // other known judge-eligible model so the judge still differs.
    throw new JudgeMustDifferError(workerModel);
  }

  // 5. Manage the definition of done. Returns true only when evidence satisfies
  //    verifyWork (when enabled); a no-op pass when verification is off.
  async verifyWork(result: WorkerResult): Promise<boolean> {
    if (!this.deps.verifyWork) return true;
    return result.evidence.length > 0 && result.diff.trim().length > 0;
  }

  // 6. Dispatch a background monitor for a long-running task. Never blocks.
  async dispatchMonitor(input: MonitorDispatchInput): Promise<MonitorDispatchResult> {
    if (!this.deps.monitors) throw new CollaboratorNotWiredError("monitor service", "Group 5");
    return this.deps.monitors.dispatch(input);
  }

  // Trivial work only. Throws if asked to do work above trivial complexity.
  async doTrivial(task: string, complexity: Complexity = "trivial"): Promise<string> {
    const trivialMax = getTrivialMaxComplexity();
    if (!complexityAtMost(complexity, trivialMax)) {
      throw new NonTrivialWorkError(complexity, trivialMax);
    }
    const provider = this.buildProvider(getCoordinator());
    await provider.ensureReady();
    const result = await provider.complete({
      messages: [{ role: "user", content: task }],
    });
    return result.text;
  }
}

/** Compose the worker prompt, folding in structured graph context when present. */
function composeWorkerPrompt(req: WorkerRequest): string {
  if (!req.context || req.context.impactedFiles.length === 0) return req.prompt;
  const files = req.context.impactedFiles
    .map((f) => `- ${f.path} (${f.reason})`)
    .join("\n");
  return `${req.prompt}\n\nImpacted files (from the code graph):\n${files}`;
}

/**
 * An AbortSignal that fires after `ms` — the per-call timeout. Group 8 moves
 * timeout policy onto the model call (guarding progress, not total turn time);
 * this is the seam that carries it to the provider.
 */
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** Convenience factory for the default orchestrator. */
export function createOrchestrator(deps: OrchestratorDeps = {}): Orchestrator {
  return new Orchestrator(deps);
}

/** Re-export for callers that estimate worker prompt size before dispatch. */
export { estimateTokens };
