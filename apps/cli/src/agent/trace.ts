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
 * These interfaces USED to be a second, hand-copied set living here. They are
 * the engine's single source of truth — it is the engine that actually runs the
 * pipeline and emits {@link StageEvent}s and builds {@link TurnTrace}s — so the
 * copy had already drifted: the engine's `TurnTrace` carries a `thinkingLog`
 * (per-round chain-of-thought, persisted for `/replay` and memory mining) that
 * the CLI copy had dropped entirely. Re-exporting restores it and removes the
 * drift surface. Every `../agent/trace.js` import in the CLI keeps resolving
 * unchanged because these re-exports keep the same names.
 *
 * The framework-free contract still holds (no Ink, no AI SDK here); the four
 * `Record<StageKind, …>` presentation maps that colour/label stages for the TUI
 * stay CLI-owned in the renderer (`repl/components.tsx`), not here.
 */
export type {
  StageKind,
  StageEvent,
  PromptEvaluation,
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
