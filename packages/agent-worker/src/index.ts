/**
 * @oxagen/agent-worker — the durable-run worker harness (agent-engine v2
 * Phase 2c; docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * Fully dependency-injected: this package consumes a structural `RunStore`
 * port and an injected `TurnDriver`, never a concrete implementation. The
 * integration PR that follows Phase 2a (Postgres schema) + Phase 2b
 * (`createPostgresRunStore`) wires the real store and `executeTurn` — see
 * `src/main.ts` for the (currently TODO) process entrypoint.
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
