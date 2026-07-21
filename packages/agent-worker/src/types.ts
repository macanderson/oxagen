/**
 * Public types for the durable-run worker harness (agent-engine v2 Phase 2c —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * This package is deliberately dependency-free beyond dev tooling: two sibling
 * workstreams are building the Postgres schema and the concrete `RunStore`
 * (Phase 2a/2b) in parallel, so `RunStore` is declared here STRUCTURALLY —
 * matching the fixed contract exactly, field for field — rather than imported.
 * A later integration PR swaps in `createPostgresRunStore` + `executeTurn`
 * (the real `TurnDriver`) without touching this package's internals, because
 * TypeScript's structural typing means any object shaped like `RunStore`
 * satisfies it, real or fake.
 */

/** A run claimed off the durable-run queue, ready to be driven to completion. */
export interface ClaimedRun {
  runId: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  surface: string;
  spec: unknown;
  attempts: number;
  /** Restored engine state from the last committed checkpoint, or null for a fresh run. */
  checkpoint: unknown | null;
  /** Seq of the last event durably appended as of the restored checkpoint. 0 for a fresh run. */
  checkpointSeq: number;
  /**
   * The run's persistent AGENT principal (iam.principals kind='agent'),
   * present when this run was dispatched as a deployed agent run rather than
   * a bare conversational turn (docs/specs/agent-rbac/spec.md §3.1/§3.4).
   * Present together with `humanPrincipal` or not at all — never minted by
   * this package, always supplied by whoever enqueued the run.
   */
  agentPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
  /** The invoking HUMAN principal this agent run acts on behalf of. */
  humanPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
}

/** One event in a run's append-only event log, seq assigned by the worker (never the store). */
export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * Structural port over the durable-run store (Postgres, Phase 2a/2b — built by
 * sibling workstreams). Implemented exactly by `createPostgresRunStore` in a
 * later integration PR; this package never imports that implementation.
 *
 * `renewLease`, `saveCheckpoint`, `completeRun`, `failRun`, and `cancelRun` all
 * return `false` instead of throwing when the caller has lost ownership of the
 * run (lease expired and reclaimed by another worker, or the run already
 * reached a terminal state) — a benign lost race, not an error. The worker
 * harness tolerates `false` everywhere without throwing; only a `false` from
 * `renewLease` or `saveCheckpoint` is treated as "lease lost", which aborts
 * the run's signal and stops all further store writes for it (the other
 * claimant owns the row now).
 *
 * `appendEvents` is idempotent server-side (`ON CONFLICT DO NOTHING` on
 * `(run_id, seq)`), so replaying a batch after a crash — before the worker
 * knew whether the previous attempt's write landed — is always safe.
 */
export interface RunStore {
  claimNextRun(workerId: string): Promise<ClaimedRun | null>;
  renewLease(runId: string, workerId: string): Promise<boolean>;
  appendEvents(
    runId: string,
    orgId: string,
    workspaceId: string,
    events: RunEventRecord[],
  ): Promise<void>;
  saveCheckpoint(
    runId: string,
    workerId: string,
    checkpointSeq: number,
    checkpoint: unknown,
  ): Promise<boolean>;
  completeRun(
    runId: string,
    workerId: string,
    result: unknown,
  ): Promise<boolean>;
  failRun(runId: string, workerId: string, error: string): Promise<boolean>;
  cancelRun(runId: string, workerId: string): Promise<boolean>;
  isCancelRequested(runId: string): Promise<boolean>;
}

/**
 * Drives one claimed run to completion in ordinary process memory. Emits
 * events via `io.onEvent` (synchronous — the worker assigns the seq and
 * buffers the event; flushing happens on the worker's own schedule, never
 * inline with the call), honors `io.signal` for cancellation (lease loss OR
 * a cancel request both abort the same signal — the driver does not need to
 * know which), and may call `io.checkpoint(state)` at safe resumption points.
 *
 * A later integration PR supplies the real driver (`executeTurn` wired to the
 * embedded/TS engine); this package only depends on the function shape.
 */
export interface TurnDriver {
  (
    run: ClaimedRun,
    io: {
      onEvent: (type: string, payload: unknown) => void;
      checkpoint: (state: unknown) => Promise<void>;
      signal: AbortSignal;
    },
  ): Promise<{ result: unknown }>;
}

/** Non-fatal error sink. Must never throw — the harness calls it best-effort and does not await it. */
export type WorkerErrorHandler = (
  err: unknown,
  ctx: { runId?: string; phase: string },
) => void;

export interface WorkerOptions {
  store: RunStore;
  driveTurn: TurnDriver;
  /** Claim/lease owner identity. Default: `${os.hostname()}:${process.pid}`. */
  workerId?: string;
  /** Simultaneous runs driven by this process. Default 2. */
  concurrency?: number;
  /** Idle poll backoff base (full jitter, exponential, capped ~15s). Default 2000. */
  pollIntervalMs?: number;
  /** Lease renewal cadence. Default 240_000 (lease is 600s server-side). */
  leaseRenewIntervalMs?: number;
  /** Cancellation poll cadence. Default 5000. */
  cancelPollIntervalMs?: number;
  /** Non-fatal error sink, e.g. for logging. Never thrown from; the harness ignores its return value. */
  onError?: WorkerErrorHandler;
}

export interface AgentWorker {
  start(): void;
  /**
   * Graceful shutdown: stop claiming new runs and stop polling for
   * cancellation, abort nothing, wait for every in-flight run to finish on
   * its own (lease renewal keeps running for each until it does), then
   * resolve.
   */
  stop(): Promise<void>;
}
