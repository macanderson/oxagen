export * from "./types";
export * from "./ports";
export { MemoryWorkspace } from "./workspaces/memory";
export {
  buildWorkspaceTools,
  formatWithLineNumbers,
  describeEditFailure,
  clipMiddle,
} from "./tools";
// Un-poisonable edits — stale-read hash anchor + syntax-regression gate
// enforced inside write_file/edit_file (Phase 1 "verified green").
export {
  createEditGuard,
  countSyntaxErrors,
  computeEditResult,
  staleFileDeniedMessage,
  syntaxRegressionDeniedMessage,
  type EditGuard,
  type EditGuardOptions,
  type EditVerdict,
  type SyntaxReport,
  type TsLikeModule,
} from "./guard/edit-guard";
// LocalWorkspace is a CLI adapter (Stage B), not engine code — see ADR-019.
export {
  runCodingAgent,
  changedFilesFromDiff,
  isErrorResult,
  stringifyCapped,
  DEFAULT_AGENT_MODEL,
} from "./engine";

// Stage A4 — model router + rate card.
export * from "./router/index";

// Stage A6 — trace types + system prompt.
export * from "./trace/types";
export * from "./prompt/system-prompt";

// Stage A5 — evaluator + judge + prompt enhancer.
export * from "./evaluate/index";

// Stage A7 — fleet task/plan/snapshot types. The engine's Fleet orchestrator
// class itself was retired (the CLI's fleet/orchestrator.ts is the live one);
// these types remain the shared vocabulary for the planner.
export * from "./fleet/types";

// Stage A7 — pipeline + planner.
export * from "./pipeline/index";
export * from "./planner/index";

// Lifecycle bounds — max-lifetime ceilings + RSS watchdog for every
// dispatched/long-lived agent process (fleet workers, daemons, runners).
export * from "./lifecycle/index";

// Scalpel F4/F7 — cache-fork trunk snapshot + hypothesis probes (public API
// for the CLI best-of-N fork mode; other scalpel modules are consumed
// internally via relative imports and don't need barrel exports).
export * from "./fork";
export * from "./oracle/hypotheses";
