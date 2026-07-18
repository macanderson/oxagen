/**
 * @oxagen/agent-runner — the platform's single seam into the agent engine
 * (agent-engine v2 Phase 1; docs/specs/agent-engine-v2/plan.md, ADR-033).
 *
 * Surfaces import ONLY this package for engine-facing wiring; direct
 * `runCodingAgent`/`runTurn` imports outside it are a review error (the
 * Phase 1 exit criterion). Engine types and constants the surfaces legitimately
 * need are re-exported so the rule is cheap to follow.
 */
export {
  executeTurn,
  executePipelineTurn,
  type PlatformSurface,
} from "./execute-turn";

// Phase 2b — durable-run persistence (docs/specs/agent-engine-v2/plan.md,
// Phase 2). run-store.ts is the only writer of agent.agent_runs /
// agent.agent_run_events; surfaces and the worker pool both go through this
// seam rather than issuing their own SQL against those tables.
export {
  createPostgresRunStore,
  MAX_RUN_ATTEMPTS,
  RUN_LEASE_SECONDS,
  type RunStore,
  type EnqueueRunInput,
  type ClaimedRun,
  type RunEventRecord,
} from "./run-store";

// Re-exports so surfaces don't need a second engine-facing import. Types are
// pass-throughs; the constants are advertised limits, not engine behavior.
export {
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_AGENT_STEPS,
} from "@oxagen/agent-engine";
export type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
  RunTurnOptions,
  RunTurnResult,
  CodingEvent,
} from "@oxagen/agent-engine";
