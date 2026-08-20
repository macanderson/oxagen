/**
 * @oxagen/agent-worker — the durable-run worker harness (agent-engine v2;
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * Fully dependency-injected: this package consumes a structural `RunStore`
 * port and an injected `TurnDriver`, never a concrete implementation.
 * `src/main.ts` is the process entrypoint — it wires the real store
 * (`createPostgresRunStore` from `@oxagen/agent-runner`) and the real driver
 * (`createPlatformTurnDriver` from `@oxagen/agent`, which reaches the engine
 * via `executeTurn`).
 */
export { createAgentWorker, TERMINAL_EVENT_TYPE } from "./worker";
export {
  CANCEL_REASON_CODE,
  DRIVER_ERROR_REASON_CODE,
  decideAttemptTerminalAction,
} from "./terminal";
export type {
  AgentWorker,
  ClaimedRun,
  RunEventRecord,
  RunStore,
  TurnDriver,
  WorkerErrorHandler,
  WorkerOptions,
} from "./types";
// Fenced V2 attempt execution (docs/specs/run-evidence-ingress/spec.md).
export type {
  AttemptCheckpointRecord,
  AttemptEventEmission,
  AttemptEventRecord,
  AttemptRunStore,
  AttemptTerminalStatus,
  AttemptTurnDriver,
  AttemptTurnIo,
  AttemptTurnOutcome,
  AttemptWorkerOptions,
  ClaimedRunV2,
  ClaimedRunV2Detail,
  ResolvedEngineIdentity,
  RestoredCheckpointRef,
  RunLeaseRef,
  SealedAttemptHandle,
} from "./types";
export type {
  AttemptTerminalDecision,
  AttemptTerminalInput,
  WorkerSealStatus,
} from "./terminal";
