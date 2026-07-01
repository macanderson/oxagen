/**
 * Public surface of the orchestrator + routing layer (Group 2).
 *
 * The primary agent is a coordinator: it gathers context, routes work to the
 * cheapest capable model, dispatches workers, and only does trivial work itself.
 * Later groups import from here to run the loop and to read the recorded worker
 * model (Group 6 forces a different judge model from it).
 */
export type {
  Complexity,
  ContextResolver,
  Coordinator,
  GraphQueryInput,
  GraphResult,
  ImpactedFile,
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
  WorkerTier,
} from "./types.js";

export { ModelRouter, createRouter, type RouterOptions } from "./router.js";

export {
  CollaboratorNotWiredError,
  JudgeMustDifferError,
  NonTrivialWorkError,
  Orchestrator,
  createOrchestrator,
  type OrchestratorDeps,
} from "./orchestrator.js";

export {
  defaultLogSink,
  formatLogLine,
  type DispatchLogEntry,
  type LogSink,
  type OrchestratorLogEntry,
  type RouteLogEntry,
} from "./logging.js";

export {
  COMPLEXITY_SCALE,
  complexityAtMost,
  complexityRank,
  getCheapBasicWorker,
  getDefaultCodeWorker,
  getSwitchCostTokenBudget,
  getTrivialMaxComplexity,
} from "./config.js";
