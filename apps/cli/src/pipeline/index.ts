/**
 * Assist and review tools (pipeline Group 4).
 *
 * The coordinator's agent-to-agent helpers for the edges of a turn:
 *   - {@link runPromptEnhancer} — step 1: enhance an incomplete prompt.
 *   - {@link runSurvey}         — step 1: ask the developer when they're the best source.
 *   - {@link runJudge}          — step 5: the quality gate (different model from the worker).
 *   - {@link decideClarification} — the ask-versus-guess decision that routes step 1.
 *
 * Group 6 wires these into the 5-step pipeline and the quality gate.
 */
export * from "./types.js";
export * from "./config.js";
export { formatToolLine, logTool, type ToolEvent, type LogField } from "./logging.js";
export { runPromptEnhancer, type EnhanceDeps } from "./prompt-enhancer.js";
export { runJudge, JudgeSameModelError, type JudgeDeps } from "./judge.js";
export {
  runSurvey,
  normalizeQuestions,
  terminalPrompter,
  type SurveyPrompter,
  type SurveyDeps,
} from "./survey.js";
export { decideClarification, type ClarificationDecision, type ClarificationSignals } from "./decide.js";
export { assistTools, createAssistToolSet, type AssistToolDeps } from "./tools.js";

// ── Group 6 — the 5-step pipeline, plan tool, verify gate, unified config ────
export {
  Pipeline,
  type PipelineCoordinator,
  type PipelineDeps,
  type PipelineRunInput,
  type PipelineRunResult,
  type StepResult,
} from "./state-machine.js";
export { runPlan, type PlanInput, type PlanOutput, type PlanTask } from "./plan.js";
export {
  GrepFallbackResolver,
  type ContextResolver,
  type GraphClient,
  type GraphQueryInput,
  type GraphResult,
  type GrepFallbackDeps,
  type GrepSearch,
  type ImpactedFile,
} from "./context-fallback.js";
export {
  defaultPipelineLogSink,
  formatPipelineLine,
  type PipelineLogEntry,
  type PipelineLogSink,
} from "./pipeline-logging.js";
export {
  InvalidPipelineConfigError,
  loadUnifiedConfig,
  validateUnifiedConfig,
  type GraphConfig,
  type UnifiedConfig,
} from "./unified-config.js";
