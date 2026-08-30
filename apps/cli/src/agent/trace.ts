/**
 * Turn-trace types — re-exported from `@oxagen/agent-engine`.
 *
 * Every user prompt becomes a {@link TurnTrace}: what the user typed, how the
 * cheap evaluator scored it, the context the enhancer injected, which model was
 * selected and why, what the advisor judge concluded about completeness, and the
 * full chain of thought from each stage. The trace is persisted so the whole
 * process stays inspectable after the fact — nothing about how the agent reached
 * its answer is hidden from the user.
 *
 * The engine owns these interfaces, because the engine is what runs the pipeline,
 * emits {@link StageEvent}s, and builds {@link TurnTrace}s. This file only
 * re-exports them under the same names, so every `../agent/trace.js` import in
 * the CLI keeps resolving and there is no second copy to drift.
 *
 * This module stays framework-free: no Ink, no AI SDK. The four
 * `Record<StageKind, …>` maps that colour and label stages for the TUI belong to
 * the renderer (`repl/components.tsx`), not here.
 */
export type {
  StageKind,
  StageEvent,
  PromptEvaluation,
  ContextRetrieval,
  EnhancementTrace,
  PhaseStat,
  ToolEvent,
  JudgeVerdict,
  TurnTrace,
  // Pre-execution scope-review snapshot + the caller's gate decision — the
  // engine surfaces these after ROUTE / before EXECUTE (see runTurn's
  // `onScopeReview` / `confirmScope`). Re-exported here so the REPL renderer and
  // the /review overlay import them through the same barrel as every other
  // trace type.
  ScopeReviewInfo,
  ScopeReviewDecision,
} from "@oxagen/agent-engine";
