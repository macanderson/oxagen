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
export { createAgentWorker } from "./worker";
export type {
  AgentWorker,
  ClaimedRun,
  RunEventRecord,
  RunStore,
  TurnDriver,
  WorkerErrorHandler,
  WorkerOptions,
} from "./types";
