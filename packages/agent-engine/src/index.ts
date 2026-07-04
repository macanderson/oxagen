export * from "./types";
export * from "./ports";
export { MemoryWorkspace } from "./workspaces/memory";
export { buildWorkspaceTools, formatWithLineNumbers, describeEditFailure } from "./tools";
// LocalWorkspace is a CLI adapter (Stage B), not engine code — see ADR-019.
export { runCodingAgent, changedFilesFromDiff, isErrorResult, stringifyCapped, DEFAULT_AGENT_MODEL } from "./engine";

// Stage A4 — model router + rate card.
export * from "./router/index";

// Stage A6 — trace types + system prompt.
export * from "./trace/types";
export * from "./prompt/system-prompt";

// Stage A5 — evaluator + judge + prompt enhancer.
export * from "./evaluate/index";

// Stage A7 — fleet types + orchestrator.
export * from "./fleet/index";

// Stage A7 — pipeline + planner.
export * from "./pipeline/index";
export * from "./planner/index";

// Scalpel F4/F7 — cache-fork trunk snapshot + hypothesis probes (public API
// for the CLI best-of-N fork mode; other scalpel modules are consumed
// internally via relative imports and don't need barrel exports).
export * from "./fork";
export * from "./oracle/hypotheses";
