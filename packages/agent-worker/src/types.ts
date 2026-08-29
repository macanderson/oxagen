/**
 * Public types for the durable-run worker harness (agent-engine v2 —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * This package is deliberately dependency-free beyond dev tooling: `RunStore`
 * is declared here STRUCTURALLY — matching the fixed contract exactly, field
 * for field — rather than imported from `@oxagen/agent-runner`. That is a
 * design decision, not scaffolding: the concrete store
 * (`createPostgresRunStore`) and the real `TurnDriver` (`executeTurn`) are
 * wired in `src/main.ts` without touching this package's internals, because
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
}

/** One event in a run's append-only event log, seq assigned by the worker (never the store). */
export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * Structural port over the durable-run store (Postgres). Implemented exactly
 * by `createPostgresRunStore` in `@oxagen/agent-runner`; this package never
 * imports that implementation.
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

// ═══════════════════════════════════════════════════════════════════════════
// V2 — fenced immutable attempts (docs/specs/run-evidence-ingress/spec.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// Declared as a SEPARATE port rather than folded into `RunStore` above. The V1
// port and the V1 worker loop stay byte-for-byte valid while queued legacy work
// drains, and `worker.ts` switches to `AttemptRunStore` in the worker-cutover
// task — a change of one type, not a rewrite of this file's contract.
//
// Same structural-typing discipline as `RunStore`: these shapes mirror
// @oxagen/agent-runner's exports field for field and are NOT imported, so this
// package keeps zero runtime dependencies.

/**
 * The complete fencing reference for one attempt. An `(runId, workerId)` pair
 * alone cannot distinguish two executions of the same run, so a reclaimed
 * run's events could interleave with the attempt that no longer owns it.
 *
 * Every fenced operation echoes this whole tuple. Unlike the V1 port's
 * `false`-on-lost-lease convention, a fenced V2 operation THROWS: a stale
 * attempt that kept writing would be appending to evidence another attempt now
 * owns, which is not a benign lost race.
 */
export interface RunLeaseRef {
  runId: string;
  attemptId: string;
  attemptPublicId: string;
  leaseToken: string;
  leaseEpoch: number;
}

/** The engine binary that actually executed — pinned on the attempt at claim. */
export interface ResolvedEngineIdentity {
  name: string;
  version: string;
  /** `sha256:…` build or container-image digest. */
  buildDigest: string;
}

/** Provenance of a checkpoint a successor restored, from a PRIOR attempt. */
export interface RestoredCheckpointRef {
  attemptId: string;
  attemptPublicId: string;
  checkpointId: string;
  checkpointDigest: string;
  streamDigest: string;
  engineStateSchema: string;
  /** `evb_` reference to the tenant-encrypted engine state. */
  encryptedStateRef: string;
  attemptSeq: number;
  runSeq: number;
}

/** Trusted V2 identity plus this attempt's own resolved facts. */
export interface ClaimedRunV2Detail {
  runKind: string;
  specDigest: string;
  initiatingPrincipalId: string;
  agentPrincipalId: string;
  agentId: string;
  agentVersionId: string;
  agentVersionChecksum: string;
  authorizationSnapshotId: string;
  parentRunId: string | null;
  repositoryBindingId: string | null;
  repositoryBindingPublicId: string | null;
  repositoryProvider: string | null;
  providerRepositoryId: string | null;
  repositoryConnectionId: string | null;
  configuredDefaultRef: string | null;
  baseCommitSha: string | null;
  baseTreeSha: string | null;
  retentionPolicyId: string;
  retentionPolicyPublicId: string;
  retentionPolicyDigest: string;
  maxAttempts: number;
  attemptNumber: number;
  engine: ResolvedEngineIdentity;
  restore: RestoredCheckpointRef | null;
}

/** A claimed V2 run: a legacy-shaped claim with non-null attempt identity. */
export interface ClaimedRunV2 extends ClaimedRun {
  specVersion: 2;
  lease: RunLeaseRef;
  v2: ClaimedRunV2Detail;
}

/**
 * One V2 event as the worker emits it. Exactly one of `payload` (allow-listed
 * receipt metadata, capped at 32 KiB after JCS) or `encryptedPayloadRef` plus
 * `payloadDigest` (a tenant-encrypted blob).
 *
 * `observedAt` is inside `event_digest`. A replayed batch MUST resend the
 * ORIGINAL value — re-stamping the clock changes the digest and turns a benign
 * retry into a hard same-sequence/different-digest integrity conflict.
 */
export interface AttemptEventRecord {
  /** Producer-assigned, dense from 1, reset for each new attempt. */
  attemptSeq: number;
  eventType: string;
  /** RFC 3339 with an explicit zone. */
  observedAt: string;
  payload?: unknown;
  encryptedPayloadRef?: string;
  payloadDigest?: string;
}

/** Checkpoint committed by the same transaction as the append it terminates. */
export interface AttemptCheckpointRecord {
  engineStateSchema: string;
  checkpointDigest: string;
  encryptedStateRef: string;
}

export interface AppendedAttemptEvent {
  attemptSeq: number;
  /** Run-global sequence as an exact decimal string (Postgres bigint). */
  runSeq: string;
  eventId: string;
  eventDigest: string;
  /** True when this sequence was already durable with an IDENTICAL digest. */
  idempotent: boolean;
}

export interface AppendAttemptBatchResult {
  events: AppendedAttemptEvent[];
  lastAttemptSeq: number;
  lastRunSeq: string;
  eventCount: number;
  eventStreamDigest: string;
  finalEventDigest: string | null;
  checkpointId: string | null;
}

export type AttemptTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "denied"
  | "abandoned";

/** What a sealed attempt hands back — its one-shot finalization authority. */
export interface SealedAttemptHandle {
  runId: string;
  attemptId: string;
  attemptPublicId: string;
  sealId: string;
  terminalStatus: string;
  grantId: string;
  /** The `afg_` grant public id. */
  grantPublicId: string;
  /** The same value, under the name the evidence envelope uses. */
  submissionId: string;
  obligationId: string;
  eventCount: number;
  finalEventDigest: string | null;
  eventStreamDigest: string;
  alreadySealed: boolean;
}

/**
 * Structural port over the V2 fenced-attempt store. Every method here either
 * succeeds or throws; there is no `false`-means-lost-lease convention, because
 * a fenced attempt must stop immediately rather than continue with a degraded
 * write path.
 */
export interface AttemptRunStore {
  claimNextRunV2(
    workerId: string,
    options: {
      engine: ResolvedEngineIdentity;
      restorableEngineStateSchemas?: readonly string[];
      leaseSeconds?: number;
    },
  ): Promise<ClaimedRunV2 | null>;
  renewAttemptLease(
    lease: RunLeaseRef,
    leaseSeconds?: number,
  ): Promise<{ expiresAt: Date }>;
  isAttemptCancelRequested(lease: RunLeaseRef): Promise<boolean>;
  /** One transaction: events + optional checkpoint + lease/run pointers. */
  appendAttemptBatch(input: {
    lease: RunLeaseRef;
    events: readonly AttemptEventRecord[];
    checkpoint?: AttemptCheckpointRecord;
  }): Promise<AppendAttemptBatchResult>;
  /** One transaction: terminal event + fence + seal + grant + obligation. */
  sealAttempt(input: {
    lease: RunLeaseRef;
    terminalStatus: AttemptTerminalStatus;
    reasonCode?: string;
    terminalEvent?: AttemptEventRecord;
    sealerWorkerId: string;
    error?: string;
    result?: unknown;
  }): Promise<SealedAttemptHandle>;
}

/**
 * One evidence event as a V2 driver hands it to the worker.
 *
 * Deliberately WITHOUT `attemptSeq`, `observedAt`, or `stage`:
 *
 *  - `attemptSeq` is the worker's — a driver that assigned its own would be
 *    guessing at a contiguity invariant it cannot see across batches;
 *  - `observedAt` is stamped ONCE by the worker at emit time and then frozen,
 *    because it is inside `event_digest`: a replayed batch that re-stamped the
 *    clock would turn a benign retry into an integrity conflict;
 *  - `stage` is not a producer input at all. The nine evidence stages are
 *    derived from the CLOSED event vocabulary by the store
 *    (`@oxagen/agent-runner`'s `EVENT_TYPE_REGISTRY`), so an event type and its
 *    stage can never disagree. An unregistered `eventType` is refused before
 *    any SQL exists.
 *
 * Exactly one of `payload` (allow-listed receipt metadata, capped at 32 KiB
 * after JCS) or `encryptedPayloadRef` + `payloadDigest` (a tenant-encrypted
 * blob). Large or sensitive bodies take the encrypted branch — the inline
 * branch rejects raw path/uri/content/prompt/diff/stdout/credential fields.
 */
export type AttemptEventEmission = Omit<
  AttemptEventRecord,
  "attemptSeq" | "observedAt"
>;

/** What a V2 driver settles with when it finishes deliberately. */
export interface AttemptTurnOutcome {
  result: unknown;
  /**
   * `completed` by default. `denied` is the ONLY other deliberate settle: an
   * authorization refusal is a decided outcome, not a crash, and must seal as
   * `denied` rather than `failed`. `cancelled` and `failed` are the worker's
   * to decide (from the cancel poller and from a driver throw), and
   * `abandoned` belongs exclusively to the lease reclaimer.
   */
  terminalStatus?: "completed" | "denied";
  /** Lowercase snake_case, ≤64 chars; anything else is dropped, not sealed. */
  reasonCode?: string;
}

/** The fenced IO surface a V2 driver executes against. */
export interface AttemptTurnIo {
  /** Buffer one event. Synchronous — the append happens on the worker's schedule. */
  onEvent: (emission: AttemptEventEmission) => void;
  /**
   * Commit every buffered event AND this checkpoint in ONE `appendAttemptBatch`
   * transaction. There is no separate checkpoint-save call: a checkpoint is
   * bound to the final event of the append it terminates, so it cannot be
   * written without one — calling this with nothing buffered throws.
   */
  checkpoint: (checkpoint: AttemptCheckpointRecord) => Promise<void>;
  signal: AbortSignal;
}

/**
 * Drives one claimed V2 attempt. The V1 `TurnDriver` below is kept verbatim
 * for already-enqueued legacy work; this is a separate port rather than a
 * widened one because the two record versions have different sequence
 * semantics, different IO, and different terminal paths.
 */
export interface AttemptTurnDriver {
  (run: ClaimedRunV2, io: AttemptTurnIo): Promise<AttemptTurnOutcome>;
}

/**
 * Everything the worker needs to claim and drive fenced V2 attempts.
 *
 * Its absence is the V2 claim gate: `WorkerOptions.attempts` is optional, and a
 * worker configured without it never issues a V2 claim and behaves exactly as
 * the V1 harness always has. PR 1A ships the path disabled on purpose —
 * enabling V2 execution before PR 2B's finalization consumption exists would
 * mint obligations no deployed worker can satisfy.
 */
export interface AttemptWorkerOptions {
  store: AttemptRunStore;
  driveTurn: AttemptTurnDriver;
  /** The engine binary this process actually runs; pinned on every attempt. */
  engine: ResolvedEngineIdentity;
  /** Engine-state schemas this build can restore. Omit to never restore. */
  restorableEngineStateSchemas?: readonly string[];
  leaseSeconds?: number;
  /**
   * Best-effort observer of every seal — for logging and telemetry ONLY.
   *
   * It is NOT the finalization path and must never become one. The seal
   * transaction already created the durable obligation carrying this handle's
   * `submissionId`; finalization is drained from that table by an independent,
   * retryable consumer, so a worker that crashes the instant after sealing
   * strands nothing. Anything this observer throws is swallowed.
   */
  onSealed?: (handle: SealedAttemptHandle) => void;
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
  /**
   * Fenced V2 attempt execution. Omitted ⇒ this worker never issues a V2
   * claim and drives V1 work only — the shipped PR 1A configuration. Supplied
   * ⇒ each claim loop tries the V2 queue first and falls back to V1, so
   * already-enqueued legacy work keeps draining either way.
   */
  attempts?: AttemptWorkerOptions;
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
