/**
 * RunStore — durable-run persistence for agent-engine v2 Phase 2b
 * (docs/specs/agent-engine-v2/plan.md, Phase 2: "Durable runs").
 *
 * `executeTurn`/`executePipelineTurn` (execute-turn.ts) are in-process today —
 * a turn lives and dies with the request. Phase 2 makes a turn a durable row:
 * `agent.agent_runs` (one row per run, claim/lease/attempts for a worker pool)
 * and the append-only `agent.agent_run_events` log (`UNIQUE(run_id, seq)`,
 * the source for resumable SSE, ClickHouse tailing, and replay). This module
 * is the ONLY thing that writes those two tables — schema in the sibling
 * Phase 2a PR, the worker/wiring in a later PR; this module depends on
 * neither, only on the fixed table contract both sides were handed.
 *
 * Claiming mirrors packages/inngest-functions/src/lease.ts exactly: a single
 * atomic `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` — no
 * separate SELECT, so there is no TOCTOU window and N concurrent workers
 * cooperatively drain the queue instead of double-claiming a run. A claim
 * takes a lease (RUN_LEASE_SECONDS); the worker renews it on a timer around
 * the turn (see lease.ts's startLeaseRenewal for the pattern — reused
 * verbatim by the Phase 2c wiring, not duplicated here). MAX_RUN_ATTEMPTS
 * bounds retries so a run that can never complete eventually fails instead of
 * being reclaimed forever; a lease-sweep cron (mirroring
 * agent.lease-sweep.ts) is the sibling wiring PR's job, not this module's.
 *
 * withTenantDb vs withSystemDb — which methods use which, and why:
 *
 *   - `enqueueRun`, `requestCancel`, `isCancelRequested`, `readEventsSince`,
 *     `getRunByPublicId` use withTenantDb. Their signatures carry NO
 *     org/workspace args beyond what `enqueueRun`'s input already needs for
 *     the row itself (`requestCancel(runId)`, `isCancelRequested(runId)`, and
 *     `getRunByPublicId(publicId)` take a bare id) — there is no scope for
 *     this module to construct even if it wanted to. These are called from a
 *     request-handling surface that already runs inside a tenant ALS scope
 *     (the platform's CapabilityHandler middleware, same precondition every
 *     `withTenantDb` caller in packages/handlers relies on); this module
 *     never calls `runInTenantScope` itself, it just assumes the caller
 *     holds scope, exactly like packages/handlers/src/connection.delete.ts.
 *     (This module does NOT depend on `@oxagen/tenancy` — `withTenantDb`
 *     only requires an active ALS scope from *somewhere*, established by the
 *     caller, unlike lease.ts's tenant-scoped functions, which take
 *     orgId/workspaceId and open their own scope. It can't: the bare-id
 *     methods above have no org/workspace to construct a scope from even if
 *     this module wanted to call `runInTenantScope` itself.)
 *   - `claimNextRun`, `renewLease`, `appendEvents`, `saveCheckpoint`,
 *     `completeRun`, `failRun`, `cancelRun` use withSystemDb. These run on the
 *     WORKER, which has no tenant ALS scope at all — it is a small pool
 *     claiming runs across every org (deliberately cross-tenant, the same
 *     shape as agent.lease-sweep.ts's sweep queries). Once a run is claimed,
 *     the worker knows its org/workspace from the claimed row and passes them
 *     explicitly into `appendEvents` — the guard on every subsequent write is
 *     `claimed_by = $workerId AND status = 'running'`, not a tenant GUC.
 *     This is the audited, explicit RLS-bypass path
 *     (packages/database/src/tenant.ts's withSystemDb doc), not a shortcut.
 *
 * Every terminal/guarded write (`renewLease`, `saveCheckpoint`, `completeRun`,
 * `failRun`, `cancelRun`) is a single `UPDATE ... WHERE claimed_by = $w AND
 * status = 'running' RETURNING id` — the guard IS the WHERE clause, and
 * "did it actually update" is read off `rows.length > 0`, never a driver
 * rowCount (unreliable across the drizzle/postgres.js boundary — same reason
 * lease.ts's claim query uses RETURNING). A worker whose lease was reclaimed
 * after expiry can never resurrect its writes.
 *
 * `appendEvents` is `INSERT ... ON CONFLICT (run_id, seq) DO NOTHING` — a
 * crash between the DB write and the caller's ack means the retry re-sends
 * the same (seq, payload) pairs, and the conflict silently no-ops them
 * instead of duplicating the log.
 *
 * Every SQL-building and row-mapping decision below is a pure, exported
 * function — unit-testable without a database. The RunStore methods
 * themselves are exercised in run-store.test.ts with a fake `tx.execute`
 * (via @oxagen/database's `makeWithTenantDbMock`/`makeWithSystemDbMock` test
 * doubles) that captures the SQL/params and scripts row returns; no live DB
 * is required. A DB-backed integration test lands with the worker wiring PR
 * once the Phase 2a schema is merged (same split lease.test.ts /
 * lease.integration.test.ts already uses).
 */
import { sql, type SQL } from "drizzle-orm";
import { withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import type { PlatformSurface } from "./execute-turn";
import {
  assertRunRowMatchesSpec,
  runSpecV2Digest,
  type RunRowIdentity,
  type RunSpecV2,
} from "./run-spec-v2";
import {
  advanceEventStreamDigest,
  computeEventDigest,
  EMPTY_EVENT_STREAM_DIGEST,
  EVENT_SCHEMA_VERSION,
  isTerminalEventType,
  validateEncryptedEventReference,
  validateInlineEventPayload,
} from "./event-payload-registry";
import {
  buildInsertFinalizationGrantSql,
  buildInsertFinalizationObligationSql,
  buildSelectFinalizationHandleSql,
  generateAttemptPublicId,
  generateFinalizationGrantPublicId,
  mapFinalizationHandleRow,
  type FinalizationHandleRow,
  type SealedAttemptHandle,
} from "./finalization-grant";
import {
  RunEventIntegrityError,
  RunEventSequenceGapError,
  RunLeaseFencedError,
  RunStoreStateError,
  type LeaseRejectionReason,
} from "./run-errors";

/** A row is failed (not requeued/reclaimed) once claimed this many times. */
export const MAX_RUN_ATTEMPTS = 3;

/** Lease window per claim — long enough for a slow multi-step agent turn. */
export const RUN_LEASE_SECONDS = 600;

/** Default page size for readEventsSince when the caller doesn't cap it. */
export const DEFAULT_READ_EVENTS_LIMIT = 500;

/** Default batch size for one lease-reclaim sweep. */
export const DEFAULT_RECLAIM_LIMIT = 25;

/**
 * The security-event type appended when the same `(attempt_id, attempt_seq)`
 * arrives twice with different digests. Task 5 adds it to
 * `SECURITY_EVENT_TYPES` in @oxagen/compliance; this constant is the single
 * spelling both sides use.
 */
export const EVENT_SEQUENCE_CONFLICT_EVENT =
  "agent_run.event_sequence_conflict";

export interface EnqueueRunInput {
  orgId: string;
  workspaceId: string;
  surface: PlatformSurface;
  spec: unknown;
}

/**
 * A claimed run, in the shape every existing caller already consumes.
 *
 * The three V2 fields are ADDITIVE on purpose. `apps/api`'s run routes,
 * `packages/agent-worker`'s structural port, and `packages/agent`'s turn driver
 * all type against this shape and are owned by other tasks in this PR; turning
 * the return into a `V1 | V2` union would break every one of them at once.
 * Extra fields stay assignable, so the compatibility dispatcher can hand back a
 * fully-typed V2 claim through the same channel that keeps already-enqueued V1
 * work claimable.
 */
export interface ClaimedRun {
  runId: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  surface: string;
  spec: unknown;
  attempts: number;
  checkpoint: unknown | null;
  checkpointSeq: number;
  /** 1 = legacy run-global claim, 2 = fenced immutable attempt. */
  specVersion: 1 | 2;
  /** The fencing token set. Non-null exactly when `specVersion === 2`. */
  lease: RunLeaseRef | null;
  /** Trusted identity + attempt detail. Non-null exactly when V2. */
  v2: ClaimedRunV2Detail | null;
}

/**
 * A V2 claim, narrowed. Structurally a `ClaimedRun`, so it flows through every
 * existing caller unchanged while the V2 worker path gets non-null `lease`/`v2`
 * without a cast.
 */
export interface ClaimedRunV2 extends ClaimedRun {
  specVersion: 2;
  lease: RunLeaseRef;
  v2: ClaimedRunV2Detail;
}

/**
 * The complete fencing reference for one attempt. Replaces the V1 notion of a
 * lease as "(runId, workerId)" — that pair cannot distinguish two executions of
 * the same run, which is precisely how a reclaimed run's events used to
 * interleave. Every fenced operation (renew, append, checkpoint, cancel check,
 * seal) echoes this whole tuple and is refused unless all of it matches an
 * unfenced, unexpired, unsealed lease.
 */
export interface RunLeaseRef {
  runId: string;
  attemptId: string;
  attemptPublicId: string;
  leaseToken: string;
  leaseEpoch: number;
}

/** The engine binary that actually executed — pinned at claim time. */
export interface ResolvedEngineIdentity {
  name: string;
  version: string;
  /** `sha256:…` build or container-image digest. */
  buildDigest: string;
}

/**
 * Provenance of a checkpoint a successor restored. The successor keeps its OWN
 * attempt identity and records where the state came from; attempt ids are never
 * reused (spec.md §"Attempt identity").
 */
export interface RestoredCheckpointRef {
  attemptId: string;
  attemptPublicId: string;
  checkpointId: string;
  checkpointDigest: string;
  /** The prior attempt's stream digest as of that checkpoint. */
  streamDigest: string;
  engineStateSchema: string;
  /** `evb_` reference to the tenant-encrypted engine state. */
  encryptedStateRef: string;
  attemptSeq: number;
  runSeq: number;
}

/** Trusted V2 identity columns plus this attempt's own resolved facts. */
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

export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * One V2 event as a producer emits it. Exactly one of `payload` (inline,
 * allow-listed receipt metadata) or `encryptedPayloadRef` + `payloadDigest`
 * (a tenant-encrypted blob) — mirroring the database's own
 * `(payload_inline IS NULL) <> (encrypted_payload_ref IS NULL)` CHECK.
 *
 * `observedAt` is the PRODUCER's observation time and is inside `event_digest`.
 * A replayed batch MUST resend the original value: re-stamping the clock
 * changes the digest and converts a benign retry into a hard integrity
 * conflict.
 */
export interface AttemptEventInput {
  /** Producer-assigned, dense from 1, reset for each new attempt. */
  attemptSeq: number;
  eventType: string;
  /** RFC 3339 with an explicit zone. */
  observedAt: string;
  payload?: unknown;
  encryptedPayloadRef?: string;
  /** Required with `encryptedPayloadRef`; derived from `payload` otherwise. */
  payloadDigest?: string;
}

/**
 * A checkpoint committed by the SAME transaction as the append it terminates,
 * bound to that batch's final event. The stream digest is not an input — the
 * store owns it, because a producer-supplied one could claim a position in the
 * stream the log does not support.
 */
export interface AttemptCheckpointInput {
  engineStateSchema: string;
  checkpointDigest: string;
  /** `evb_` reference to the tenant-encrypted engine state. */
  encryptedStateRef: string;
}

export interface AppendAttemptBatchInput {
  lease: RunLeaseRef;
  events: readonly AttemptEventInput[];
  checkpoint?: AttemptCheckpointInput;
}

export interface AppendedAttemptEvent {
  attemptSeq: number;
  /** Run-global sequence, as an exact decimal string (Postgres bigint). */
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

/** One V2 event as a reader (resumable SSE, replay) projects it. */
export interface AttemptEventReadRecord {
  eventId: string;
  attemptId: string;
  attemptPublicId: string;
  /**
   * Run-global sequence as an exact DECIMAL STRING. `run_seq` is a Postgres
   * bigint and an SSE `id:` field is text — carrying it as a JS number would
   * silently lose precision past 2^53 and hand a subscriber a cursor that
   * resumes at the wrong event.
   */
  runSeq: string;
  attemptSeq: number;
  eventSchemaVersion: string;
  eventType: string;
  stage: string;
  payloadDigest: string;
  eventDigest: string;
  payload: unknown | null;
  encryptedPayloadRef: string | null;
  observedAt: Date;
  recordedAt: Date;
}

/** Terminal statuses an attempt seal may carry. */
export const ATTEMPT_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "denied",
  "abandoned",
] as const;
export type AttemptTerminalStatus = (typeof ATTEMPT_TERMINAL_STATUSES)[number];

export interface SealAttemptInput {
  lease: RunLeaseRef;
  terminalStatus: AttemptTerminalStatus;
  reasonCode?: string;
  /**
   * The terminal event, appended and validated in the SAME transaction as the
   * seal. Omitted only when the attempt has already appended its terminal
   * event; never omitted to make a zero-event seal look complete — that is the
   * reclaimer's separate path.
   */
  terminalEvent?: AttemptEventInput;
  sealerWorkerId: string;
  /** Recorded on `agent_runs.error` for a failed run. */
  error?: string;
  /** Result recorded on `agent_runs.result` for a completed run. */
  result?: unknown;
}

export interface ReclaimExpiredAttemptsOptions {
  reclaimerWorkerId: string;
  limit?: number;
  reasonCode?: string;
}

export interface ReclaimedAttempt {
  handle: SealedAttemptHandle;
  runId: string;
  attemptNumber: number;
  maxAttempts: number;
  /**
   * True ⇒ the run was requeued to `pending` and the NEXT `claimNextRunV2`
   * creates the successor attempt. False ⇒ the pinned `max_attempts` is
   * exhausted and the run was marked failed after its final attempt sealed.
   *
   * The reclaimer deliberately does not create the successor itself: an attempt
   * row requires a resolved engine name/version/build digest, which only a
   * claiming worker knows.
   */
  successorPermitted: boolean;
}

/**
 * Where a same-sequence/different-digest conflict is reported. Injected rather
 * than imported so this package keeps its narrow dependency set and so the sink
 * can be a real @oxagen/compliance writer, an Inngest emit, or a test spy.
 *
 * It is called OUTSIDE the append transaction, after the rollback: a sink that
 * wrote inside that transaction would have its audit row rolled back together
 * with the conflicting append, erasing the exact record this requirement
 * exists to create.
 */
export interface RunSecurityEventSink {
  recordEventSequenceConflict(event: {
    type: typeof EVENT_SEQUENCE_CONFLICT_EVENT;
    orgId: string;
    workspaceId: string;
    runId: string;
    attemptId: string;
    attemptPublicId: string;
    attemptSeq: number;
    storedDigest: string;
    incomingDigest: string;
  }): Promise<void> | void;
}

export interface RunStoreOptions {
  /**
   * Default sink: writes the conflict to `console.error`. Deliberately loud
   * rather than a silent no-op — a dropped integrity conflict is the failure
   * this whole append path exists to prevent, so the fallback must still leave
   * a trace in the worker's logs until the real sink is wired.
   */
  securityEvents?: RunSecurityEventSink;
}

/**
 * Public, tenant-facing run status — the shape the durable-run API surface
 * (apps/api's `/v1/.../runs` routes, Phase 2 integration) hands back for
 * GET /runs/:publicId and the SSE `done` terminal event. Deliberately NOT
 * `ClaimedRun` (which is a worker-internal shape carrying `spec`/checkpoint
 * state a caller never needs and org/workspace ids that RLS already scopes
 * away): this is the read-side projection callers poll/subscribe against.
 */
export interface RunSummary {
  runId: string;
  publicId: string;
  surface: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: unknown | null;
  error: string | null;
  checkpointSeq: number;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RunStore {
  enqueueRun(
    input: EnqueueRunInput,
  ): Promise<{ runId: string; publicId: string }>;
  /**
   * The compatibility claim dispatcher. Pass `options` (a resolved engine
   * identity) to claim fenced V2 work first, falling back to V1; omit it to
   * claim V1 only. The parameter is optional so every existing caller — and
   * `packages/agent-worker`'s structural port — keeps compiling unchanged.
   */
  claimNextRun(
    workerId: string,
    options?: ClaimNextRunV2Options,
  ): Promise<ClaimedRun | null>;
  renewLease(runId: string, workerId: string): Promise<boolean>;
  appendEvents(
    runId: string,
    orgId: string,
    workspaceId: string,
    events: RunEventRecord[],
  ): Promise<void>;
  readEventsSince(
    runId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<Array<RunEventRecord & { createdAt: Date }>>;
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
  requestCancel(runId: string): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
  /**
   * Look up a run's public status by its externally-addressable `public_id`
   * (the `arun_…` id `enqueueRun` mints). Tenant-scoped via `withTenantDb`
   * exactly like `readEventsSince`/`requestCancel` above — no explicit
   * org/workspace filter in the SQL, RLS does that from the caller's ALS
   * scope, so a cross-tenant publicId resolves to `null`, never another
   * org's row. Returns `null` for an unknown or cross-tenant publicId — the
   * durable-run API route maps that to a clean 404.
   */
  getRunByPublicId(publicId: string): Promise<RunSummary | null>;
}

/**
 * Trusted V2 admission input. `spec` is already parsed — this store never
 * accepts an unvalidated body — and the two `*RowId` fields are the INTERNAL
 * uuids admission resolved for the public ids the spec pins. Both kinds are
 * required because the run row stores those two bindings as uuid foreign keys
 * while the spec (a wire contract) carries their public ids; `enqueueRunV2`
 * proves the pair actually agree by joining the inserted row back to the
 * binding/policy rows and comparing what Postgres stored against the spec.
 *
 * There is deliberately no `status` or scheduling input. The pending
 * `agent_runs` row IS the durable queue; this task does not invent a second
 * scheduling outbox for a worker that does not exist yet.
 */
export interface EnqueueRunV2Input {
  orgId: string;
  workspaceId: string;
  surface: PlatformSurface;
  spec: RunSpecV2;
  /** Internal uuid of `context_policy.retention_policy_id`'s version row. */
  retentionPolicyRowId: string;
  /** Internal uuid of the pinned repository binding; null for a general run. */
  repositoryBindingRowId: string | null;
}

/**
 * The V2 fenced-attempt surface, kept SEPARATE from `RunStore` rather than
 * bolted onto it. `apps/api` and `packages/agent-worker` both type against
 * `RunStore` and are owned by other tasks in this PR, so a new required method
 * there would break them in CI rather than here.
 * `createPostgresRunStore()` returns `RunStore & AttemptRunStore`, so a caller
 * that wants the V2 surface simply keeps the inferred type.
 */
export interface AttemptRunStore {
  /** Trusted V2 admission. Verifies every typed column against the spec. */
  enqueueRunV2(
    input: EnqueueRunV2Input,
  ): Promise<{ runId: string; publicId: string; specDigest: string }>;

  /**
   * Claim one pending V2 run: pin the engine identity, create a distinct
   * immutable attempt, take the next lease epoch, optionally restore a valid
   * prior checkpoint, and return the complete restore reference.
   */
  claimNextRunV2(
    workerId: string,
    options: ClaimNextRunV2Options,
  ): Promise<ClaimedRunV2 | null>;

  /**
   * The retained V1 claim path. Kept so already-enqueued and explicitly
   * non-evidence legacy work stays claimable until its later retirement.
   */
  claimLegacyV1(workerId: string): Promise<ClaimedRun | null>;

  /** Renew a fenced lease. Throws `RunLeaseFencedError` if the claim is lost. */
  renewAttemptLease(
    lease: RunLeaseRef,
    leaseSeconds?: number,
  ): Promise<{ expiresAt: Date }>;

  /** Live cancellation check, gated on the same fencing tuple as a write. */
  isAttemptCancelRequested(lease: RunLeaseRef): Promise<boolean>;

  /**
   * Append a contiguous batch and its optional checkpoint in ONE transaction,
   * advancing the lease pointers and the run's sequence allocator with it.
   */
  appendAttemptBatch(
    input: AppendAttemptBatchInput,
  ): Promise<AppendAttemptBatchResult>;

  /**
   * Seal a worker-observed terminal attempt: append/validate the terminal
   * event, fence the lease, and insert the seal, the non-expiring one-shot
   * finalization grant, and the durable obligation — atomically.
   */
  sealAttempt(input: SealAttemptInput): Promise<SealedAttemptHandle>;

  /**
   * Reclaim expired attempts. Seals each as `abandoned` (zero-event attempts
   * use the empty-stream sentinel and synthesize NOTHING), mints its grant and
   * obligation in the same transaction, then requeues the run for a successor
   * while the pinned `max_attempts` permits, or fails it.
   */
  reclaimExpiredAttempts(
    options: ReclaimExpiredAttemptsOptions,
  ): Promise<ReclaimedAttempt[]>;

  /** Resumable V2 subscription read, cursored on the decimal `run_seq`. */
  readAttemptEventsSince(
    runId: string,
    afterRunSeq: string,
    limit?: number,
  ): Promise<AttemptEventReadRecord[]>;
}

export interface ClaimNextRunV2Options {
  /** The engine binary this worker will actually run. Pinned on the attempt. */
  engine: ResolvedEngineIdentity;
  /**
   * Engine-state schema versions this worker can restore. A checkpoint written
   * by an incompatible engine build is not restored — the successor starts
   * clean rather than mis-parsing state. Omit or pass `[]` to never restore.
   */
  restorableEngineStateSchemas?: readonly string[];
  leaseSeconds?: number;
}

// ── Pure helpers — id generation + row mapping ──────────────────────────────

/**
 * Mint a public id for a new run. Same shape as provision-webhook.ts's
 * `whs_` ids: a fixed prefix + 22 hex chars sliced from a UUIDv4 with its
 * dashes stripped — collision-safe without a DB round-trip.
 */
export function generateRunPublicId(): string {
  return `arun_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

type ClaimedRunRow = {
  id: string;
  public_id: string;
  org_id: string;
  workspace_id: string;
  surface: string;
  spec: unknown;
  attempts: number | string;
  checkpoint: unknown | null;
  checkpoint_seq: number | string;
};

/**
 * Map a claimed legacy agent_runs row to ClaimedRun. `specVersion`/`lease`/`v2`
 * are pinned to the V1 values: a legacy claim has no attempt identity and no
 * fencing token, and saying so explicitly is what lets a consumer branch on
 * `specVersion` instead of sniffing for undefined fields.
 */
export function mapClaimedRunRow(row: ClaimedRunRow): ClaimedRun {
  return {
    runId: row.id,
    publicId: row.public_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    surface: row.surface,
    spec: row.spec,
    attempts: Number(row.attempts),
    checkpoint: row.checkpoint ?? null,
    checkpointSeq: Number(row.checkpoint_seq),
    specVersion: 1,
    lease: null,
    v2: null,
  };
}

type RunEventRow = {
  seq: number | string;
  type: string;
  payload: unknown;
  created_at: string | Date;
};

/** Map an agent_run_events row to the public RunEventRecord shape. */
export function mapRunEventRow(
  row: RunEventRow,
): RunEventRecord & { createdAt: Date } {
  return {
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
  };
}

type RunSummaryRow = {
  id: string;
  public_id: string;
  surface: string;
  status: string;
  result: unknown | null;
  error: string | null;
  checkpoint_seq: number | string;
  attempts: number | string;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
};

function toDateOrNull(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Map an agent_runs row (snake_case, driver-typed) to the public RunSummary. */
export function mapRunSummaryRow(row: RunSummaryRow): RunSummary {
  return {
    runId: row.id,
    publicId: row.public_id,
    surface: row.surface,
    status: row.status as RunSummary["status"],
    result: row.result ?? null,
    error: row.error ?? null,
    checkpointSeq: Number(row.checkpoint_seq),
    attempts: Number(row.attempts),
    createdAt: toDateOrNull(row.created_at) as Date,
    startedAt: toDateOrNull(row.started_at),
    completedAt: toDateOrNull(row.completed_at),
  };
}

// ── Pure SQL builders — exported so query shape is unit-testable ───────────

export function buildEnqueueRunSql(
  publicId: string,
  input: EnqueueRunInput,
): SQL {
  return sql`
    INSERT INTO agent.agent_runs (public_id, org_id, workspace_id, surface, status, spec)
    VALUES (
      ${publicId},
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.surface},
      'pending',
      ${JSON.stringify(input.spec)}::jsonb
    )
    RETURNING id, public_id
  `;
}

export function buildClaimNextRunSql(
  workerId: string,
  maxAttempts: number = MAX_RUN_ATTEMPTS,
  leaseSeconds: number = RUN_LEASE_SECONDS,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'running',
      claimed_by = ${workerId},
      attempts = attempts + 1,
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      started_at = coalesce(started_at, now()),
      updated_at = now()
    WHERE id = (
      SELECT id FROM agent.agent_runs
      WHERE attempts < ${maxAttempts}
        AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, public_id, org_id, workspace_id, surface, spec, attempts, checkpoint, checkpoint_seq
  `;
}

export function buildRenewLeaseSql(
  runId: string,
  workerId: string,
  leaseSeconds: number = RUN_LEASE_SECONDS,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      updated_at = now()
    WHERE id = ${runId}::uuid
      AND claimed_by = ${workerId}
      AND status = 'running'
    RETURNING id
  `;
}

/**
 * Multi-row `INSERT ... VALUES (...), (...) ON CONFLICT DO NOTHING`. Returns
 * null for an empty batch — callers must skip the round-trip entirely rather
 * than execute a query with no VALUES rows.
 */
export function buildAppendEventsSql(
  runId: string,
  orgId: string,
  workspaceId: string,
  events: RunEventRecord[],
): SQL | null {
  if (events.length === 0) return null;
  const rows = events.map(
    (e) =>
      sql`(${runId}::uuid, ${orgId}::uuid, ${workspaceId}::uuid, ${e.seq}, ${e.type}, ${JSON.stringify(e.payload)}::jsonb)`,
  );
  return sql`
    INSERT INTO agent.agent_run_events (run_id, org_id, workspace_id, seq, type, payload)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (run_id, seq) DO NOTHING
  `;
}

export function buildReadEventsSinceSql(
  runId: string,
  afterSeq: number,
  limit: number = DEFAULT_READ_EVENTS_LIMIT,
): SQL {
  return sql`
    SELECT seq, type, payload, created_at
    FROM agent.agent_run_events
    WHERE run_id = ${runId}::uuid
      AND seq > ${afterSeq}
    ORDER BY seq ASC
    LIMIT ${limit}
  `;
}

export function buildSaveCheckpointSql(
  runId: string,
  workerId: string,
  checkpointSeq: number,
  checkpoint: unknown,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      checkpoint = ${JSON.stringify(checkpoint)}::jsonb,
      checkpoint_seq = ${checkpointSeq},
      updated_at = now()
    WHERE id = ${runId}::uuid
      AND claimed_by = ${workerId}
      AND status = 'running'
    RETURNING id
  `;
}

export function buildCompleteRunSql(
  runId: string,
  workerId: string,
  result: unknown,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'completed',
      result = ${JSON.stringify(result)}::jsonb,
      completed_at = now(),
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${runId}::uuid
      AND claimed_by = ${workerId}
      AND status = 'running'
    RETURNING id
  `;
}

export function buildFailRunSql(
  runId: string,
  workerId: string,
  error: string,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'failed',
      error = ${error},
      completed_at = now(),
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${runId}::uuid
      AND claimed_by = ${workerId}
      AND status = 'running'
    RETURNING id
  `;
}

export function buildCancelRunSql(runId: string, workerId: string): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'cancelled',
      completed_at = now(),
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${runId}::uuid
      AND claimed_by = ${workerId}
      AND status = 'running'
    RETURNING id
  `;
}

export function buildRequestCancelSql(runId: string): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      cancel_requested = true,
      updated_at = now()
    WHERE id = ${runId}::uuid
  `;
}

export function buildIsCancelRequestedSql(runId: string): SQL {
  return sql`
    SELECT cancel_requested
    FROM agent.agent_runs
    WHERE id = ${runId}::uuid
  `;
}

/**
 * Look up the public status projection by `public_id`. No org/workspace
 * filter — RLS scopes the read from the caller's tenant ALS session, exactly
 * like `buildReadEventsSinceSql`/`buildIsCancelRequestedSql` above.
 */
export function buildGetRunByPublicIdSql(publicId: string): SQL {
  return sql`
    SELECT id, public_id, surface, status, result, error, checkpoint_seq, attempts, created_at, started_at, completed_at
    FROM agent.agent_runs
    WHERE public_id = ${publicId}
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 — fenced immutable attempts
// ═══════════════════════════════════════════════════════════════════════════
//
// Every decision below is a pure exported function and every query a pure
// exported builder; the store methods are thin transaction orchestration over
// them. That split is not stylistic: the replay/idempotency classification and
// the digest fold are the branchiest logic in this package, and they have to be
// provable without a database.

/**
 * Mint an opaque lease bearer token. A full UUID (not a slice) because this is
 * the only secret in the fencing tuple — the attempt id is not secret, and a
 * token derived from it would make a leaked id sufficient to write.
 */
export function generateLeaseToken(): string {
  return crypto.randomUUID();
}

export { generateAttemptPublicId };

/**
 * The exact typed identity a V2 admission must write, derived from the parsed
 * spec. Exported so admission, the post-insert verification, and the tests all
 * read the same projection instead of three hand-copied field lists.
 */
export function buildRunRowIdentityFromSpec(spec: RunSpecV2): RunRowIdentity {
  const repository =
    spec.run_kind === "repo_edit" ? spec.repository_binding : null;
  return {
    spec_version: spec.version,
    run_kind: spec.run_kind,
    spec_digest: runSpecV2Digest(spec),
    initiating_principal_id: spec.actor_binding.initiating_principal_id,
    agent_principal_id: spec.actor_binding.agent_principal_id,
    agent_id: spec.actor_binding.agent_id,
    agent_version_id: spec.actor_binding.agent_version_id,
    agent_version_checksum: spec.actor_binding.agent_version_checksum,
    authorization_snapshot_id: spec.authorization_snapshot_ref.snapshot_id,
    parent_run_id: spec.actor_binding.parent_run_id ?? null,
    repository_binding_public_id:
      repository?.repository_binding_public_id ?? null,
    provider: repository?.provider ?? null,
    provider_repository_id: repository?.provider_repository_id ?? null,
    connection_id: repository?.connection_id ?? null,
    configured_default_ref: repository?.configured_default_ref ?? null,
    base_commit_sha: repository?.base_commit_sha ?? null,
    base_tree_sha: repository?.base_tree_sha ?? null,
    retention_policy_id: spec.context_policy.retention_policy_id,
    retention_policy_digest: spec.context_policy.retention_policy_digest,
    max_attempts: spec.engine_policy.max_attempts,
  };
}

/** Typed columns a V2 run row returns, joined to the two bindings' public ids. */
export interface RunV2IdentityRow {
  spec_version: number | string;
  run_kind: string;
  spec_digest: string;
  initiating_principal_id: string;
  agent_principal_id: string;
  agent_id: string;
  agent_version_id: string;
  agent_version_checksum: string;
  authorization_snapshot_id: string;
  parent_run_id: string | null;
  repository_binding_id: string | null;
  repository_binding_public_id: string | null;
  repository_provider: string | null;
  provider_repository_id: string | null;
  repository_connection_id: string | null;
  configured_default_ref: string | null;
  base_commit_sha: string | null;
  base_tree_sha: string | null;
  retention_policy_id: string;
  retention_policy_public_id: string | null;
  retention_policy_digest: string;
  max_attempts: number | string;
}

/**
 * Project what Postgres actually stored into the shape `compareRunRowIdentity`
 * consumes. The two public-id fields come from the JOINED binding/policy rows,
 * NOT from the caller's input — that is the whole point of the join: it proves
 * the internal uuid admission resolved really does address the public id the
 * spec pinned, which a caller-supplied value could never demonstrate.
 */
export function mapRunV2IdentityRow(row: RunV2IdentityRow): RunRowIdentity {
  return {
    spec_version: Number(row.spec_version),
    run_kind: row.run_kind,
    spec_digest: row.spec_digest,
    initiating_principal_id: row.initiating_principal_id,
    agent_principal_id: row.agent_principal_id,
    agent_id: row.agent_id,
    agent_version_id: row.agent_version_id,
    agent_version_checksum: row.agent_version_checksum,
    authorization_snapshot_id: row.authorization_snapshot_id,
    parent_run_id: row.parent_run_id ?? null,
    repository_binding_public_id: row.repository_binding_public_id ?? null,
    provider: row.repository_provider ?? null,
    provider_repository_id: row.provider_repository_id ?? null,
    connection_id: row.repository_connection_id ?? null,
    configured_default_ref: row.configured_default_ref ?? null,
    base_commit_sha: row.base_commit_sha ?? null,
    base_tree_sha: row.base_tree_sha ?? null,
    retention_policy_id: row.retention_policy_public_id ?? "",
    retention_policy_digest: row.retention_policy_digest,
    max_attempts: Number(row.max_attempts),
  };
}

// ── Batch planning: replays vs appends ──────────────────────────────────────

/** One event, resolved to everything the row and the digests need. */
export interface PreparedAttemptEvent {
  attemptSeq: number;
  eventSchemaVersion: string;
  eventType: string;
  stage: string;
  payloadDigest: string;
  eventDigest: string;
  payload: unknown | null;
  encryptedPayloadRef: string | null;
  observedAt: string;
}

/**
 * Validate one event against the registry and compute its digests. Throws for
 * an unknown type, a forbidden inline field, an oversized payload, or a
 * malformed encrypted reference — all BEFORE any SQL exists.
 */
export function prepareAttemptEvent(
  event: AttemptEventInput,
): PreparedAttemptEvent {
  const hasInline = event.payload !== undefined;
  const hasEncrypted = event.encryptedPayloadRef !== undefined;
  if (hasInline === hasEncrypted) {
    throw new RunStoreStateError(
      `event ${event.eventType} seq ${event.attemptSeq} must carry exactly one ` +
        `of an inline payload or an encrypted payload reference`,
    );
  }

  let stage: string;
  let payloadDigest: string;
  let payload: unknown | null = null;
  let encryptedPayloadRef: string | null = null;

  if (hasInline) {
    const validated = validateInlineEventPayload(
      event.eventType,
      event.payload,
    );
    stage = validated.stage;
    payloadDigest = validated.payloadDigest;
    payload = validated.payload;
  } else {
    const validated = validateEncryptedEventReference(
      event.eventType,
      event.encryptedPayloadRef as string,
      event.payloadDigest ?? "",
    );
    stage = validated.stage;
    payloadDigest = validated.payloadDigest;
    encryptedPayloadRef = event.encryptedPayloadRef as string;
  }

  const eventDigest = computeEventDigest({
    attemptSeq: event.attemptSeq,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventType: event.eventType,
    stage,
    payloadDigest,
    observedAt: event.observedAt,
  });

  return {
    attemptSeq: event.attemptSeq,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventType: event.eventType,
    stage,
    payloadDigest,
    eventDigest,
    payload,
    encryptedPayloadRef,
    observedAt: event.observedAt,
  };
}

export interface AttemptBatchPlan {
  /** Sequences at or below the lease pointer — candidates for idempotent reuse. */
  replays: PreparedAttemptEvent[];
  /** Sequences past the lease pointer — genuinely new rows. */
  appends: PreparedAttemptEvent[];
}

/**
 * Split a prepared batch into the part that is already durable and the part
 * that is new, refusing anything that would leave a hole in the stream.
 *
 * `attempt_seq` is producer-assigned and DENSE from 1, so three shapes are
 * rejected outright rather than repaired:
 *
 *  - a batch that is not internally contiguous (`5, 7`) — an event was lost
 *    before it was ever durable, and accepting the rest would ratify that loss;
 *  - a batch that starts past `lastAttemptSeq + 1` — the same hole, across
 *    batches;
 *  - a non-positive sequence.
 *
 * A batch that starts at or below the pointer is a crash retry: those events
 * are looked up and digest-compared by the caller, never blindly re-inserted.
 */
export function planAttemptBatch(
  attemptId: string,
  lastAttemptSeq: number,
  events: readonly PreparedAttemptEvent[],
): AttemptBatchPlan {
  const plan: AttemptBatchPlan = { replays: [], appends: [] };
  if (events.length === 0) return plan;

  const first = events[0] as PreparedAttemptEvent;
  if (first.attemptSeq < 1) {
    throw new RunEventSequenceGapError(attemptId, 1, first.attemptSeq);
  }
  if (first.attemptSeq > lastAttemptSeq + 1) {
    throw new RunEventSequenceGapError(
      attemptId,
      lastAttemptSeq + 1,
      first.attemptSeq,
    );
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as PreparedAttemptEvent;
    const expected = first.attemptSeq + i;
    if (event.attemptSeq !== expected) {
      throw new RunEventSequenceGapError(attemptId, expected, event.attemptSeq);
    }
    if (event.attemptSeq <= lastAttemptSeq) plan.replays.push(event);
    else plan.appends.push(event);
  }
  return plan;
}

/** An already-durable event, as the replay lookup returns it. */
export interface ExistingAttemptEventRow {
  id: string;
  attempt_seq: number | string;
  run_seq: number | string;
  event_digest: string;
}

/**
 * Reconcile a replayed prefix against what is already durable.
 *
 * Identical digest ⇒ the prior row and its run sequence are returned unchanged
 * (the crash-retry case). A DIFFERENT digest for the same sequence is never
 * dropped: it means two writers observed different executions of the same
 * position, so the ordered stream is no longer one provable history. That
 * throws `RunEventIntegrityError`, which the caller reports through the
 * security-event sink AFTER the transaction rolls back. This is exactly what
 * `ON CONFLICT DO NOTHING` used to hide, and why the V2 insert has no
 * conflict clause at all.
 */
export function reconcileReplayedEvents(
  attemptId: string,
  replays: readonly PreparedAttemptEvent[],
  existing: readonly ExistingAttemptEventRow[],
): AppendedAttemptEvent[] {
  const bySeq = new Map<number, ExistingAttemptEventRow>();
  for (const row of existing) bySeq.set(Number(row.attempt_seq), row);

  return replays.map((event) => {
    const row = bySeq.get(event.attemptSeq);
    if (!row) {
      // The lease pointer says this sequence is committed but no row exists —
      // the pointer and the log disagree, so neither is trustworthy.
      throw new RunStoreStateError(
        `attempt ${attemptId} lease reports seq ${event.attemptSeq} committed ` +
          `but no event row exists`,
      );
    }
    if (row.event_digest !== event.eventDigest) {
      throw new RunEventIntegrityError(
        attemptId,
        event.attemptSeq,
        row.event_digest,
        event.eventDigest,
      );
    }
    return {
      attemptSeq: event.attemptSeq,
      runSeq: String(row.run_seq),
      eventId: row.id,
      eventDigest: row.event_digest,
      idempotent: true,
    };
  });
}

/**
 * Fold the running stream digest over the NEW events only. Replayed events are
 * already inside `previousDigest` — folding them twice would move the digest
 * on every retry and make a sealed attempt un-verifiable.
 */
export function foldAttemptStreamDigest(
  previousDigest: string,
  appended: readonly PreparedAttemptEvent[],
): string {
  return appended.reduce<string>(
    (digest, event) =>
      advanceEventStreamDigest(digest, {
        attemptSeq: event.attemptSeq,
        eventSchemaVersion: event.eventSchemaVersion,
        eventType: event.eventType,
        payloadDigest: event.payloadDigest,
      }),
    previousDigest,
  );
}

// ── Lease validation ────────────────────────────────────────────────────────

/** The locked lease row, joined to its attempt's public id and seal state. */
export interface LockedLeaseRow {
  id: string;
  attempt_id: string;
  attempt_public_id: string;
  run_id: string;
  org_id: string;
  workspace_id: string;
  lease_token: string;
  lease_epoch: number | string;
  worker_id: string;
  expired: boolean;
  fenced_at: string | Date | null;
  last_run_seq: number | string | null;
  last_attempt_seq: number | string | null;
  event_count: number | string;
  final_event_digest: string | null;
  event_stream_digest: string | null;
  seal_id: string | null;
}

/**
 * Why a fenced operation must be refused, or `null` when it may proceed.
 * Returned rather than thrown so the reclaimer — which legitimately operates on
 * an EXPIRED lease, that being the entire point of a reclaim — can accept that
 * one reason while still refusing a fenced or already-sealed attempt.
 */
export function leaseRejectionReason(
  row: LockedLeaseRow | undefined,
  lease: RunLeaseRef,
  options: { allowExpired?: boolean } = {},
): LeaseRejectionReason | null {
  if (!row) return "unknown_lease";
  if (row.lease_token !== lease.leaseToken) return "token_mismatch";
  if (Number(row.lease_epoch) !== lease.leaseEpoch) return "epoch_mismatch";
  // `sealed` is checked BEFORE `fenced` on purpose: a seal always fences its
  // own lease, so testing the fence first would report every duplicate seal as
  // a generic fence and the idempotent duplicate-sweep path could never
  // recognize itself. A fence WITHOUT a seal is the genuine "another attempt
  // took this run" case and still reports `fenced`.
  if (row.seal_id !== null) return "sealed";
  if (row.fenced_at !== null) return "fenced";
  if (row.expired && !options.allowExpired) return "expired";
  return null;
}

/** Throwing form of `leaseRejectionReason`, used by every fenced write. */
export function assertLeaseUsable(
  row: LockedLeaseRow | undefined,
  lease: RunLeaseRef,
  options: { allowExpired?: boolean } = {},
): LockedLeaseRow {
  const reason = leaseRejectionReason(row, lease, options);
  if (reason !== null) throw new RunLeaseFencedError(lease.attemptId, reason);
  return row as LockedLeaseRow;
}

// ── V2 SQL builders ─────────────────────────────────────────────────────────

/**
 * Insert the trusted V2 run row and read back what Postgres stored, joined to
 * the repository-binding and retention-policy rows the internal uuids address.
 * The join is the verification: it turns "the caller says this uuid is that
 * public id" into "the database agrees", which is what
 * `assertRunRowMatchesSpec` then checks against the spec.
 */
export function buildEnqueueRunV2Sql(
  publicId: string,
  specDigest: string,
  input: EnqueueRunV2Input,
): SQL {
  const spec = input.spec;
  const repository =
    spec.run_kind === "repo_edit" ? spec.repository_binding : null;
  return sql`
    WITH inserted AS (
      INSERT INTO agent.agent_runs (
        public_id, org_id, workspace_id, surface, status, spec,
        spec_version, run_kind, spec_digest,
        initiating_principal_id, agent_principal_id, agent_id,
        agent_version_id, agent_version_checksum,
        authorization_snapshot_id, parent_run_id,
        repository_binding_id, repository_provider, provider_repository_id,
        repository_connection_id, configured_default_ref,
        base_commit_sha, base_tree_sha,
        retention_policy_id, retention_policy_digest, max_attempts
      )
      VALUES (
        ${publicId},
        ${input.orgId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.surface},
        'pending',
        ${JSON.stringify(spec)}::jsonb,
        2,
        ${spec.run_kind},
        ${specDigest},
        ${spec.actor_binding.initiating_principal_id}::uuid,
        ${spec.actor_binding.agent_principal_id}::uuid,
        ${spec.actor_binding.agent_id}::uuid,
        ${spec.actor_binding.agent_version_id}::uuid,
        ${spec.actor_binding.agent_version_checksum},
        ${spec.authorization_snapshot_ref.snapshot_id}::uuid,
        ${spec.actor_binding.parent_run_id ?? null}::uuid,
        ${input.repositoryBindingRowId}::uuid,
        ${repository?.provider ?? null},
        ${repository?.provider_repository_id ?? null},
        ${repository?.connection_id ?? null}::uuid,
        ${repository?.configured_default_ref ?? null},
        ${repository?.base_commit_sha ?? null},
        ${repository?.base_tree_sha ?? null},
        ${input.retentionPolicyRowId}::uuid,
        ${spec.context_policy.retention_policy_digest},
        ${spec.engine_policy.max_attempts}
      )
      RETURNING *
    )
    SELECT
      i.id, i.public_id, i.spec_version, i.run_kind, i.spec_digest,
      i.initiating_principal_id, i.agent_principal_id, i.agent_id,
      i.agent_version_id, i.agent_version_checksum,
      i.authorization_snapshot_id, i.parent_run_id,
      i.repository_binding_id, i.repository_provider, i.provider_repository_id,
      i.repository_connection_id, i.configured_default_ref,
      i.base_commit_sha, i.base_tree_sha,
      i.retention_policy_id, i.retention_policy_digest, i.max_attempts,
      rb.public_id AS repository_binding_public_id,
      rpv.public_id AS retention_policy_public_id
    FROM inserted i
    LEFT JOIN ingestion.repository_bindings rb ON rb.id = i.repository_binding_id
    LEFT JOIN evidence.retention_policy_versions rpv ON rpv.id = i.retention_policy_id
  `;
}

/**
 * Lock exactly one claimable V2 run.
 *
 * Eligibility is `pending` ONLY. A running V2 run is never stolen by a claim,
 * however stale its lease looks: fencing an expired attempt means sealing it,
 * minting its finalization grant, and enqueuing its obligation, and that is
 * `reclaimExpiredAttempts`' transaction. A claim that quietly took the row
 * would strand exactly the evidence the reclaim exists to preserve.
 */
export function buildLockClaimableRunV2Sql(): SQL {
  return sql`
    SELECT
      r.id, r.public_id, r.org_id, r.workspace_id, r.surface, r.spec,
      r.run_kind, r.spec_digest, r.initiating_principal_id,
      r.agent_principal_id, r.agent_id, r.agent_version_id,
      r.agent_version_checksum, r.authorization_snapshot_id, r.parent_run_id,
      r.repository_binding_id, r.repository_provider, r.provider_repository_id,
      r.repository_connection_id, r.configured_default_ref,
      r.base_commit_sha, r.base_tree_sha,
      r.retention_policy_id, r.retention_policy_digest,
      r.max_attempts, r.attempt_count, r.next_run_seq, r.latest_checkpoint_id,
      rb.public_id AS repository_binding_public_id,
      rpv.public_id AS retention_policy_public_id
    FROM agent.agent_runs r
    LEFT JOIN ingestion.repository_bindings rb ON rb.id = r.repository_binding_id
    LEFT JOIN evidence.retention_policy_versions rpv ON rpv.id = r.retention_policy_id
    WHERE r.spec_version = 2
      AND r.status = 'pending'
      AND r.attempt_count < r.max_attempts
    ORDER BY r.created_at
    LIMIT 1
    FOR UPDATE OF r SKIP LOCKED
  `;
}

/**
 * The newest checkpoint this worker may legitimately restore.
 *
 * Two filters carry weight. The seal join means only a SEALED prior attempt's
 * checkpoint is eligible — an unsealed attempt is still live or mid-reclaim,
 * and its checkpoint is not a settled position in the stream. The schema filter
 * means a checkpoint written by an engine build this worker cannot parse is
 * skipped rather than mis-read; the successor simply starts clean.
 */
export function buildSelectRestorableCheckpointSql(
  runId: string,
  engineStateSchemas: readonly string[],
): SQL {
  return sql`
    SELECT
      c.id, c.attempt_id, c.attempt_seq, c.run_seq,
      c.checkpoint_digest, c.stream_digest,
      c.engine_state_schema, c.encrypted_state_ref,
      a.public_id AS attempt_public_id
    FROM agent.agent_run_checkpoints c
    JOIN agent.agent_run_attempts a ON a.id = c.attempt_id
    JOIN agent.agent_run_attempt_seals s ON s.attempt_id = c.attempt_id
    WHERE c.run_id = ${runId}::uuid
      AND c.engine_state_schema = ANY(${engineStateSchemas as string[]}::text[])
    ORDER BY c.run_seq DESC
    LIMIT 1
  `;
}

export interface InsertAttemptInput {
  publicId: string;
  orgId: string;
  workspaceId: string;
  runId: string;
  attemptNumber: number;
  workerId: string;
  engine: ResolvedEngineIdentity;
  restore: RestoredCheckpointRef | null;
}

/** Create the immutable attempt — before any model or tool work can run. */
export function buildInsertAttemptSql(input: InsertAttemptInput): SQL {
  const restore = input.restore;
  return sql`
    INSERT INTO agent.agent_run_attempts (
      public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
      engine_name, engine_version, engine_build_digest,
      resumed_from_attempt_id, resumed_from_attempt_public_id,
      restored_checkpoint_id, restored_checkpoint_digest
    )
    VALUES (
      ${input.publicId},
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptNumber},
      ${input.workerId},
      ${input.engine.name},
      ${input.engine.version},
      ${input.engine.buildDigest},
      ${restore?.attemptId ?? null}::uuid,
      ${restore?.attemptPublicId ?? null},
      ${restore?.checkpointId ?? null}::uuid,
      ${restore?.checkpointDigest ?? null}
    )
    RETURNING id, public_id, attempt_number
  `;
}

/**
 * The next fencing epoch for a run. Read under the run's row lock, so two
 * concurrent claims cannot compute the same value — and if one somehow did,
 * `agent_run_attempt_leases_run_epoch_uq` rejects the second at write time.
 */
export function buildSelectNextLeaseEpochSql(runId: string): SQL {
  return sql`
    SELECT COALESCE(MAX(lease_epoch), 0) + 1 AS next_epoch
    FROM agent.agent_run_attempt_leases
    WHERE run_id = ${runId}::uuid
  `;
}

export interface InsertLeaseInput {
  orgId: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  leaseToken: string;
  leaseEpoch: number;
  workerId: string;
  leaseSeconds: number;
}

export function buildInsertAttemptLeaseSql(input: InsertLeaseInput): SQL {
  return sql`
    INSERT INTO agent.agent_run_attempt_leases (
      org_id, workspace_id, attempt_id, run_id, lease_token, lease_epoch,
      worker_id, expires_at, event_stream_digest
    )
    VALUES (
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.attemptId}::uuid,
      ${input.runId}::uuid,
      ${input.leaseToken},
      ${input.leaseEpoch},
      ${input.workerId},
      now() + make_interval(secs => ${input.leaseSeconds}),
      ${EMPTY_EVENT_STREAM_DIGEST}
    )
    RETURNING id, expires_at
  `;
}

/**
 * Mark the run running and point it at the new attempt. Only operational
 * columns move — the `agent_runs_v2_immutability` trigger rejects any change to
 * the trusted bindings, so this statement cannot rewrite identity even by
 * accident.
 */
export function buildMarkRunClaimedV2Sql(
  runId: string,
  workerId: string,
  attemptId: string,
  leaseSeconds: number,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'running',
      claimed_by = ${workerId},
      attempts = attempts + 1,
      attempt_count = attempt_count + 1,
      active_attempt_id = ${attemptId}::uuid,
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      started_at = coalesce(started_at, now()),
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id, attempt_count
  `;
}

/**
 * Lock one attempt's lease and everything a fenced operation must check:
 * expiry (as a server-computed boolean, never a client clock), the fence
 * tombstone, and whether a seal already exists.
 */
export function buildLockAttemptLeaseSql(attemptId: string): SQL {
  return sql`
    SELECT
      l.id, l.attempt_id, l.run_id, l.org_id, l.workspace_id,
      l.lease_token, l.lease_epoch, l.worker_id,
      (l.expires_at <= now()) AS expired,
      l.fenced_at, l.last_run_seq, l.last_attempt_seq,
      l.event_count, l.final_event_digest, l.event_stream_digest,
      a.public_id AS attempt_public_id,
      s.id AS seal_id
    FROM agent.agent_run_attempt_leases l
    JOIN agent.agent_run_attempts a ON a.id = l.attempt_id
    LEFT JOIN agent.agent_run_attempt_seals s ON s.attempt_id = l.attempt_id
    WHERE l.attempt_id = ${attemptId}::uuid
    FOR UPDATE OF l
  `;
}

/**
 * Renew a lease. The guard IS the WHERE clause — token, epoch, no fence — so a
 * worker whose attempt was reclaimed cannot extend a claim it no longer holds,
 * exactly like the V1 `claimed_by` guard.
 */
export function buildRenewAttemptLeaseSql(
  lease: RunLeaseRef,
  leaseSeconds: number = RUN_LEASE_SECONDS,
): SQL {
  return sql`
    UPDATE agent.agent_run_attempt_leases SET
      expires_at = now() + make_interval(secs => ${leaseSeconds}),
      renewed_at = now(),
      updated_at = now()
    WHERE attempt_id = ${lease.attemptId}::uuid
      AND lease_token = ${lease.leaseToken}
      AND lease_epoch = ${lease.leaseEpoch}
      AND fenced_at IS NULL
    RETURNING expires_at
  `;
}

/** Read the run's cancel flag through the lease, so the fence still gates it. */
export function buildIsAttemptCancelRequestedSql(attemptId: string): SQL {
  return sql`
    SELECT r.cancel_requested
    FROM agent.agent_run_attempt_leases l
    JOIN agent.agent_runs r ON r.id = l.run_id
    WHERE l.attempt_id = ${attemptId}::uuid
  `;
}

export function buildSelectExistingAttemptEventsSql(
  attemptId: string,
  fromSeq: number,
  toSeq: number,
): SQL {
  return sql`
    SELECT id, attempt_seq, run_seq, event_digest
    FROM agent.agent_run_events
    WHERE event_record_version = 2
      AND attempt_id = ${attemptId}::uuid
      AND attempt_seq >= ${fromSeq}
      AND attempt_seq <= ${toSeq}
    ORDER BY attempt_seq ASC
  `;
}

/**
 * Reserve `count` run-global sequences. `next_run_seq` lives on the run row —
 * not a SEQUENCE object — precisely so the allocation rolls back with a failed
 * append instead of burning numbers and leaving holes an auditor cannot
 * explain. RETURNING sees the NEW value, so subtracting `count` yields the
 * first reserved sequence.
 */
export function buildAllocateRunSeqSql(runId: string, count: number): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      next_run_seq = next_run_seq + ${count},
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING (next_run_seq - ${count})::text AS first_run_seq
  `;
}

export interface AttemptEventInsertRow extends PreparedAttemptEvent {
  runSeq: string;
}

/**
 * Multi-row V2 insert with NO conflict clause. Deliberate: a unique violation
 * on `(attempt_id, attempt_seq)` or `(run_id, run_seq)` here means two writers
 * raced past every fence check, and that must surface as an error rather than
 * vanish. (The legacy `appendEvents` above keeps `ON CONFLICT DO NOTHING` — V1
 * rows carry no digest, so the drop hides no integrity failure, and the V1
 * worker's crash-replay safety depends on it.)
 */
export function buildInsertAttemptEventsSql(
  runId: string,
  orgId: string,
  workspaceId: string,
  attemptId: string,
  events: readonly AttemptEventInsertRow[],
): SQL | null {
  if (events.length === 0) return null;
  const rows = events.map(
    (e) => sql`(
      ${runId}::uuid, ${orgId}::uuid, ${workspaceId}::uuid, 2,
      ${attemptId}::uuid, ${e.runSeq}::bigint, ${e.attemptSeq},
      ${e.eventSchemaVersion}, ${e.eventType}, ${e.stage},
      ${e.payloadDigest}, ${e.eventDigest},
      ${e.payload === null ? null : JSON.stringify(e.payload)}::jsonb,
      ${e.encryptedPayloadRef},
      ${e.observedAt}::timestamptz
    )`,
  );
  return sql`
    INSERT INTO agent.agent_run_events (
      run_id, org_id, workspace_id, event_record_version,
      attempt_id, run_seq, attempt_seq,
      event_schema_version, event_type, stage,
      payload_digest, event_digest,
      payload_inline, encrypted_payload_ref, observed_at
    )
    VALUES ${sql.join(rows, sql`, `)}
    RETURNING id, attempt_seq, run_seq::text AS run_seq
  `;
}

export interface InsertCheckpointInput {
  orgId: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  eventId: string;
  attemptSeq: number;
  runSeq: string;
  engineStateSchema: string;
  checkpointDigest: string;
  streamDigest: string;
  encryptedStateRef: string;
}

export function buildInsertCheckpointSql(input: InsertCheckpointInput): SQL {
  return sql`
    INSERT INTO agent.agent_run_checkpoints (
      org_id, workspace_id, run_id, attempt_id, event_id,
      attempt_seq, run_seq, engine_state_schema,
      checkpoint_digest, stream_digest, encrypted_state_ref
    )
    VALUES (
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.eventId}::uuid,
      ${input.attemptSeq},
      ${input.runSeq}::bigint,
      ${input.engineStateSchema},
      ${input.checkpointDigest},
      ${input.streamDigest},
      ${input.encryptedStateRef}
    )
    RETURNING id
  `;
}

/** The existing checkpoint on a replayed final event, for idempotent retries. */
export function buildSelectCheckpointByEventSql(eventId: string): SQL {
  return sql`
    SELECT id, checkpoint_digest, stream_digest
    FROM agent.agent_run_checkpoints
    WHERE event_id = ${eventId}::uuid
  `;
}

export interface AdvanceLeaseInput {
  lease: RunLeaseRef;
  lastRunSeq: string;
  lastAttemptSeq: number;
  eventCount: number;
  finalEventDigest: string | null;
  eventStreamDigest: string;
}

/**
 * Advance the lease pointers in the same transaction as the append. Re-states
 * the fencing guard in its WHERE clause: even though the row is already locked,
 * an update that could not name the token and epoch has no business moving the
 * pointer a successor and the finalizer both read.
 */
export function buildAdvanceLeasePointersSql(input: AdvanceLeaseInput): SQL {
  return sql`
    UPDATE agent.agent_run_attempt_leases SET
      last_run_seq = ${input.lastRunSeq}::bigint,
      last_attempt_seq = ${input.lastAttemptSeq},
      event_count = ${input.eventCount},
      final_event_digest = ${input.finalEventDigest},
      event_stream_digest = ${input.eventStreamDigest},
      updated_at = now()
    WHERE attempt_id = ${input.lease.attemptId}::uuid
      AND lease_token = ${input.lease.leaseToken}
      AND lease_epoch = ${input.lease.leaseEpoch}
      AND fenced_at IS NULL
    RETURNING id
  `;
}

export function buildSetLatestCheckpointSql(
  runId: string,
  checkpointId: string,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      latest_checkpoint_id = ${checkpointId}::uuid,
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id
  `;
}

/**
 * Fence a lease. After this commits the attempt may perform NO further
 * mutation; the tombstone is what a stale worker observes before it shuts down.
 */
export function buildFenceAttemptLeaseSql(
  attemptId: string,
  reason: string,
): SQL {
  return sql`
    UPDATE agent.agent_run_attempt_leases SET
      fenced_at = now(),
      fenced_reason = ${reason},
      updated_at = now()
    WHERE attempt_id = ${attemptId}::uuid
      AND fenced_at IS NULL
    RETURNING id
  `;
}

export interface InsertSealInput {
  orgId: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  terminalStatus: string;
  reasonCode: string | null;
  eventCount: number;
  finalRunSeq: string | null;
  finalAttemptSeq: number | null;
  finalEventDigest: string | null;
  eventStreamDigest: string;
  sealerKind: "worker" | "reclaimer";
  sealerWorkerId: string;
}

export function buildInsertAttemptSealSql(input: InsertSealInput): SQL {
  return sql`
    INSERT INTO agent.agent_run_attempt_seals (
      org_id, workspace_id, run_id, attempt_id, terminal_status, reason_code,
      event_count, final_run_seq, final_attempt_seq, final_event_digest,
      event_stream_digest, sealer_kind, sealer_worker_id
    )
    VALUES (
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.terminalStatus},
      ${input.reasonCode},
      ${input.eventCount},
      ${input.finalRunSeq}::bigint,
      ${input.finalAttemptSeq},
      ${input.finalEventDigest},
      ${input.eventStreamDigest},
      ${input.sealerKind},
      ${input.sealerWorkerId}
    )
    RETURNING id
  `;
}

/** Terminal run status for a worker-observed seal. Clears the attempt pointer. */
export function buildFinishRunV2Sql(
  runId: string,
  status: "completed" | "failed" | "cancelled",
  result: unknown | null,
  error: string | null,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = ${status},
      result = ${result === null ? null : JSON.stringify(result)}::jsonb,
      error = ${error},
      active_attempt_id = NULL,
      claimed_by = NULL,
      lease_expires_at = NULL,
      completed_at = now(),
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id
  `;
}

/**
 * Return a reclaimed run to the queue so the NEXT claim creates its successor
 * attempt. The reclaimer cannot create that attempt itself: an attempt row
 * pins a resolved engine name, version, and build digest, and only a claiming
 * worker knows which binary it is about to run.
 */
export function buildRequeueRunForSuccessorSql(runId: string): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'pending',
      claimed_by = NULL,
      active_attempt_id = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id
  `;
}

/**
 * Expired, unfenced, unsealed leases — the reclaim sweep's work list. Ordered
 * by expiry so the longest-abandoned attempt is finalized first.
 */
export function buildSelectExpiredAttemptLeasesSql(
  limit: number = DEFAULT_RECLAIM_LIMIT,
): SQL {
  return sql`
    SELECT
      l.attempt_id, l.run_id, l.lease_token, l.lease_epoch,
      a.public_id AS attempt_public_id, a.attempt_number,
      r.max_attempts, r.attempt_count
    FROM agent.agent_run_attempt_leases l
    JOIN agent.agent_run_attempts a ON a.id = l.attempt_id
    JOIN agent.agent_runs r ON r.id = l.run_id
    LEFT JOIN agent.agent_run_attempt_seals s ON s.attempt_id = l.attempt_id
    WHERE l.fenced_at IS NULL
      AND l.expires_at <= now()
      AND s.id IS NULL
    ORDER BY l.expires_at ASC
    LIMIT ${limit}
  `;
}

/** Resumable V2 subscription read. `run_seq` is text — see the record doc. */
export function buildReadAttemptEventsSinceSql(
  runId: string,
  afterRunSeq: string,
  limit: number = DEFAULT_READ_EVENTS_LIMIT,
): SQL {
  return sql`
    SELECT
      e.id, e.attempt_id, e.run_seq::text AS run_seq, e.attempt_seq,
      e.event_schema_version, e.event_type, e.stage,
      e.payload_digest, e.event_digest, e.payload_inline,
      e.encrypted_payload_ref, e.observed_at, e.created_at,
      a.public_id AS attempt_public_id
    FROM agent.agent_run_events e
    JOIN agent.agent_run_attempts a ON a.id = e.attempt_id
    WHERE e.event_record_version = 2
      AND e.run_id = ${runId}::uuid
      AND e.run_seq > ${afterRunSeq}::bigint
    ORDER BY e.run_seq ASC
    LIMIT ${limit}
  `;
}

interface AttemptEventReadRow {
  id: string;
  attempt_id: string;
  attempt_public_id: string;
  run_seq: string;
  attempt_seq: number | string;
  event_schema_version: string;
  event_type: string;
  stage: string;
  payload_digest: string;
  event_digest: string;
  payload_inline: unknown | null;
  encrypted_payload_ref: string | null;
  observed_at: string | Date;
  created_at: string | Date;
}

export function mapAttemptEventReadRow(
  row: AttemptEventReadRow,
): AttemptEventReadRecord {
  return {
    eventId: row.id,
    attemptId: row.attempt_id,
    attemptPublicId: row.attempt_public_id,
    runSeq: String(row.run_seq),
    attemptSeq: Number(row.attempt_seq),
    eventSchemaVersion: row.event_schema_version,
    eventType: row.event_type,
    stage: row.stage,
    payloadDigest: row.payload_digest,
    eventDigest: row.event_digest,
    payload: row.payload_inline ?? null,
    encryptedPayloadRef: row.encrypted_payload_ref ?? null,
    observedAt: toDate(row.observed_at),
    recordedAt: toDate(row.created_at),
  };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

// ── In-transaction append core ───────────────────────────────────────────────

/** Driver-typed row of a lockable, claimable V2 run. */
interface ClaimableRunV2Row extends RunV2IdentityRow {
  id: string;
  public_id: string;
  org_id: string;
  workspace_id: string;
  surface: string;
  spec: unknown;
  attempt_count: number | string;
  next_run_seq: number | string;
  latest_checkpoint_id: string | null;
}

interface RestorableCheckpointRow {
  id: string;
  attempt_id: string;
  attempt_public_id: string;
  attempt_seq: number | string;
  run_seq: number | string;
  checkpoint_digest: string;
  stream_digest: string;
  engine_state_schema: string;
  encrypted_state_ref: string;
}

/**
 * Project a locked run row plus its freshly-created attempt into the claim
 * result. `checkpoint`/`checkpointSeq` are pinned to the V1-shaped null/0: a V2
 * attempt's engine state is a tenant-encrypted blob named by `v2.restore`, not
 * an inline JSON column, and `attempt_seq` always restarts at 1 for a new
 * attempt however much history the run has.
 */
export function mapClaimedRunV2(
  run: ClaimableRunV2Row,
  attempt: { id: string; public_id: string; attempt_number: number | string },
  lease: { leaseToken: string; leaseEpoch: number },
  engine: ResolvedEngineIdentity,
  restore: RestoredCheckpointRef | null,
): ClaimedRunV2 {
  return {
    runId: run.id,
    publicId: run.public_id,
    orgId: run.org_id,
    workspaceId: run.workspace_id,
    surface: run.surface,
    spec: run.spec,
    attempts: Number(attempt.attempt_number),
    checkpoint: null,
    checkpointSeq: 0,
    specVersion: 2,
    lease: {
      runId: run.id,
      attemptId: attempt.id,
      attemptPublicId: attempt.public_id,
      leaseToken: lease.leaseToken,
      leaseEpoch: lease.leaseEpoch,
    },
    v2: {
      runKind: run.run_kind,
      specDigest: run.spec_digest,
      initiatingPrincipalId: run.initiating_principal_id,
      agentPrincipalId: run.agent_principal_id,
      agentId: run.agent_id,
      agentVersionId: run.agent_version_id,
      agentVersionChecksum: run.agent_version_checksum,
      authorizationSnapshotId: run.authorization_snapshot_id,
      parentRunId: run.parent_run_id ?? null,
      repositoryBindingId: run.repository_binding_id ?? null,
      repositoryBindingPublicId: run.repository_binding_public_id ?? null,
      repositoryProvider: run.repository_provider ?? null,
      providerRepositoryId: run.provider_repository_id ?? null,
      repositoryConnectionId: run.repository_connection_id ?? null,
      configuredDefaultRef: run.configured_default_ref ?? null,
      baseCommitSha: run.base_commit_sha ?? null,
      baseTreeSha: run.base_tree_sha ?? null,
      retentionPolicyId: run.retention_policy_id,
      retentionPolicyPublicId: run.retention_policy_public_id ?? "",
      retentionPolicyDigest: run.retention_policy_digest,
      maxAttempts: Number(run.max_attempts),
      attemptNumber: Number(attempt.attempt_number),
      engine,
      restore,
    },
  };
}

function mapRestorableCheckpointRow(
  row: RestorableCheckpointRow,
): RestoredCheckpointRef {
  return {
    attemptId: row.attempt_id,
    attemptPublicId: row.attempt_public_id,
    checkpointId: row.id,
    checkpointDigest: row.checkpoint_digest,
    streamDigest: row.stream_digest,
    engineStateSchema: row.engine_state_schema,
    encryptedStateRef: row.encrypted_state_ref,
    attemptSeq: Number(row.attempt_seq),
    runSeq: Number(row.run_seq),
  };
}

/**
 * Append a prepared batch and its optional checkpoint against an ALREADY
 * LOCKED, already-validated lease, inside the caller's transaction.
 *
 * Shared by `appendAttemptBatch` and by `sealAttempt`'s terminal-event append
 * so a terminal event goes through the exact same contiguity, idempotency, and
 * digest rules as any other event — a seal cannot smuggle in an event the
 * normal path would have refused.
 */
async function appendPreparedBatchInTx(
  tx: Tx,
  lease: RunLeaseRef,
  leaseRow: LockedLeaseRow,
  prepared: readonly PreparedAttemptEvent[],
  checkpoint: AttemptCheckpointInput | undefined,
): Promise<AppendAttemptBatchResult> {
  const lastAttemptSeq = Number(leaseRow.last_attempt_seq ?? 0);
  const plan = planAttemptBatch(lease.attemptId, lastAttemptSeq, prepared);

  let replayed: AppendedAttemptEvent[] = [];
  if (plan.replays.length > 0) {
    const firstReplay = plan.replays[0] as PreparedAttemptEvent;
    const lastReplay = plan.replays[
      plan.replays.length - 1
    ] as PreparedAttemptEvent;
    const existing = (await tx.execute(
      buildSelectExistingAttemptEventsSql(
        lease.attemptId,
        firstReplay.attemptSeq,
        lastReplay.attemptSeq,
      ),
    )) as unknown as ExistingAttemptEventRow[];
    replayed = reconcileReplayedEvents(lease.attemptId, plan.replays, existing);
  }

  let appended: AppendedAttemptEvent[] = [];
  if (plan.appends.length > 0) {
    const allocated = (await tx.execute(
      buildAllocateRunSeqSql(leaseRow.run_id, plan.appends.length),
    )) as unknown as Array<{ first_run_seq: string }>;
    const firstRunSeq = allocated[0]?.first_run_seq;
    if (firstRunSeq === undefined) {
      throw new RunStoreStateError(
        `run ${leaseRow.run_id} did not allocate run sequences`,
      );
    }
    const base = BigInt(firstRunSeq);
    const rows: AttemptEventInsertRow[] = plan.appends.map((event, index) => ({
      ...event,
      runSeq: (base + BigInt(index)).toString(),
    }));
    const insert = buildInsertAttemptEventsSql(
      leaseRow.run_id,
      leaseRow.org_id,
      leaseRow.workspace_id,
      lease.attemptId,
      rows,
    );
    const returned = (await tx.execute(insert as SQL)) as unknown as Array<{
      id: string;
      attempt_seq: number | string;
      run_seq: string;
    }>;
    // Multi-row RETURNING order is not guaranteed, so match on attempt_seq
    // rather than position.
    const bySeq = new Map(returned.map((r) => [Number(r.attempt_seq), r]));
    appended = rows.map((row) => {
      const got = bySeq.get(row.attemptSeq);
      if (!got) {
        throw new RunStoreStateError(
          `attempt ${lease.attemptId} seq ${row.attemptSeq} was not returned by the insert`,
        );
      }
      return {
        attemptSeq: row.attemptSeq,
        runSeq: String(got.run_seq),
        eventId: got.id,
        eventDigest: row.eventDigest,
        idempotent: false,
      };
    });
  }

  const events = [...replayed, ...appended];
  const advanced = appended.length > 0;
  const lastAppended = advanced
    ? (appended[appended.length - 1] as AppendedAttemptEvent)
    : null;

  // Pointers never rewind: a batch that only replays an OLDER prefix leaves the
  // lease exactly where it was. Moving it backwards would let the next append
  // re-issue sequences the log already holds.
  const eventCount = Number(leaseRow.event_count) + appended.length;
  const eventStreamDigest = foldAttemptStreamDigest(
    leaseRow.event_stream_digest ?? EMPTY_EVENT_STREAM_DIGEST,
    plan.appends,
  );
  const outLastAttemptSeq = lastAppended
    ? lastAppended.attemptSeq
    : lastAttemptSeq;
  const outLastRunSeq = lastAppended
    ? lastAppended.runSeq
    : String(leaseRow.last_run_seq ?? 0);
  const outFinalEventDigest = lastAppended
    ? lastAppended.eventDigest
    : (leaseRow.final_event_digest ?? null);

  let checkpointId: string | null = null;
  if (checkpoint) {
    const finalEvent = events[events.length - 1];
    if (!finalEvent) {
      throw new RunStoreStateError(
        `attempt ${lease.attemptId} checkpoint requires at least one event in the batch`,
      );
    }
    if (advanced) {
      const rows = (await tx.execute(
        buildInsertCheckpointSql({
          orgId: leaseRow.org_id,
          workspaceId: leaseRow.workspace_id,
          runId: leaseRow.run_id,
          attemptId: lease.attemptId,
          eventId: finalEvent.eventId,
          attemptSeq: finalEvent.attemptSeq,
          runSeq: finalEvent.runSeq,
          engineStateSchema: checkpoint.engineStateSchema,
          checkpointDigest: checkpoint.checkpointDigest,
          streamDigest: eventStreamDigest,
          encryptedStateRef: checkpoint.encryptedStateRef,
        }),
      )) as unknown as Array<{ id: string }>;
      const inserted = rows[0];
      if (!inserted) {
        throw new RunStoreStateError(
          `attempt ${lease.attemptId} checkpoint insert returned no row`,
        );
      }
      checkpointId = inserted.id;
      await tx.execute(
        buildSetLatestCheckpointSql(leaseRow.run_id, checkpointId),
      );
    } else {
      // A fully-replayed batch may legitimately re-request its checkpoint. The
      // existing one must AGREE — a different digest for the same event is the
      // same class of integrity failure as a conflicting event.
      const rows = (await tx.execute(
        buildSelectCheckpointByEventSql(finalEvent.eventId),
      )) as unknown as Array<{ id: string; checkpoint_digest: string }>;
      const existing = rows[0];
      if (!existing) {
        throw new RunStoreStateError(
          `attempt ${lease.attemptId} replayed checkpoint has no stored row for event ${finalEvent.eventId}`,
        );
      }
      if (existing.checkpoint_digest !== checkpoint.checkpointDigest) {
        throw new RunEventIntegrityError(
          lease.attemptId,
          finalEvent.attemptSeq,
          existing.checkpoint_digest,
          checkpoint.checkpointDigest,
        );
      }
      checkpointId = existing.id;
    }
  }

  if (advanced) {
    const updated = (await tx.execute(
      buildAdvanceLeasePointersSql({
        lease,
        lastRunSeq: outLastRunSeq,
        lastAttemptSeq: outLastAttemptSeq,
        eventCount,
        finalEventDigest: outFinalEventDigest,
        eventStreamDigest,
      }),
    )) as unknown as Array<{ id: string }>;
    if (updated.length === 0) {
      throw new RunLeaseFencedError(lease.attemptId, "fenced");
    }
  }

  return {
    events,
    lastAttemptSeq: outLastAttemptSeq,
    lastRunSeq: outLastRunSeq,
    eventCount,
    eventStreamDigest,
    finalEventDigest: outFinalEventDigest,
    checkpointId,
  };
}

/** Run status a worker-observed terminal attempt drives its run to. */
export function runStatusForTerminal(
  terminalStatus: AttemptTerminalStatus,
): "completed" | "failed" | "cancelled" {
  if (terminalStatus === "completed") return "completed";
  if (terminalStatus === "cancelled") return "cancelled";
  // `denied` is a failure of the run, not a separate run status — the DENIAL
  // itself is evidence on the sealed attempt.
  return "failed";
}

interface SealTransactionInput {
  lease: RunLeaseRef;
  leaseRow: LockedLeaseRow;
  terminalStatus: AttemptTerminalStatus;
  reasonCode: string | null;
  eventCount: number;
  finalRunSeq: string | null;
  finalAttemptSeq: number | null;
  finalEventDigest: string | null;
  eventStreamDigest: string;
  sealerKind: "worker" | "reclaimer";
  sealerWorkerId: string;
}

/**
 * Fence, seal, mint the grant, and enqueue the obligation — the four writes
 * that MUST share one transaction. If any of them fails, none of them
 * happened: a seal without its grant would be evidence nobody is authorized to
 * finalize, and a grant without its obligation would be authority nobody is
 * scheduled to use.
 */
async function sealAttemptInTx(
  tx: Tx,
  input: SealTransactionInput,
): Promise<SealedAttemptHandle> {
  const { lease, leaseRow } = input;

  await tx.execute(
    buildFenceAttemptLeaseSql(
      lease.attemptId,
      `sealed:${input.terminalStatus}`,
    ),
  );

  const sealRows = (await tx.execute(
    buildInsertAttemptSealSql({
      orgId: leaseRow.org_id,
      workspaceId: leaseRow.workspace_id,
      runId: leaseRow.run_id,
      attemptId: lease.attemptId,
      terminalStatus: input.terminalStatus,
      reasonCode: input.reasonCode,
      eventCount: input.eventCount,
      finalRunSeq: input.finalRunSeq,
      finalAttemptSeq: input.finalAttemptSeq,
      finalEventDigest: input.finalEventDigest,
      eventStreamDigest: input.eventStreamDigest,
      sealerKind: input.sealerKind,
      sealerWorkerId: input.sealerWorkerId,
    }),
  )) as unknown as Array<{ id: string }>;
  const seal = sealRows[0];
  if (!seal) {
    throw new RunStoreStateError(
      `attempt ${lease.attemptId} seal insert returned no row`,
    );
  }

  const grantPublicId = generateFinalizationGrantPublicId();
  const grantRows = (await tx.execute(
    buildInsertFinalizationGrantSql({
      publicId: grantPublicId,
      orgId: leaseRow.org_id,
      workspaceId: leaseRow.workspace_id,
      runId: leaseRow.run_id,
      attemptId: lease.attemptId,
      attemptPublicId: lease.attemptPublicId,
      sealId: seal.id,
      eventCount: input.eventCount,
      finalEventDigest: input.finalEventDigest,
      eventStreamDigest: input.eventStreamDigest,
    }),
  )) as unknown as Array<{ id: string; public_id: string }>;
  const grant = grantRows[0];
  if (!grant) {
    throw new RunStoreStateError(
      `attempt ${lease.attemptId} finalization grant insert returned no row`,
    );
  }

  const obligationRows = (await tx.execute(
    buildInsertFinalizationObligationSql({
      orgId: leaseRow.org_id,
      workspaceId: leaseRow.workspace_id,
      grantId: grant.id,
      // The grant's own `afg_` public id IS the stable submission id.
      submissionId: grant.public_id,
      runId: leaseRow.run_id,
      attemptId: lease.attemptId,
      sealId: seal.id,
    }),
  )) as unknown as Array<{ id: string }>;
  const obligation = obligationRows[0];
  if (!obligation) {
    throw new RunStoreStateError(
      `attempt ${lease.attemptId} finalization obligation insert returned no row`,
    );
  }

  return {
    runId: leaseRow.run_id,
    attemptId: lease.attemptId,
    attemptPublicId: lease.attemptPublicId,
    sealId: seal.id,
    terminalStatus: input.terminalStatus,
    grantId: grant.id,
    grantPublicId: grant.public_id,
    submissionId: grant.public_id,
    obligationId: obligation.id,
    eventCount: input.eventCount,
    finalEventDigest: input.finalEventDigest,
    eventStreamDigest: input.eventStreamDigest,
    alreadySealed: false,
  };
}

/** Read back an existing seal's handle — the idempotent duplicate-seal path. */
async function readSealedHandleInTx(
  tx: Tx,
  lease: RunLeaseRef,
): Promise<SealedAttemptHandle> {
  const rows = (await tx.execute(
    buildSelectFinalizationHandleSql(lease.attemptId),
  )) as unknown as FinalizationHandleRow[];
  const row = rows[0];
  if (!row) {
    throw new RunStoreStateError(
      `attempt ${lease.attemptId} is sealed but has no finalization grant or obligation`,
    );
  }
  return mapFinalizationHandleRow(row, {
    runId: lease.runId,
    attemptId: lease.attemptId,
    attemptPublicId: lease.attemptPublicId,
  });
}

// ── The store ────────────────────────────────────────────────────────────────

/** Fail-loud fallback sink — see `RunStoreOptions.securityEvents`. */
const CONSOLE_SECURITY_EVENT_SINK: RunSecurityEventSink = {
  recordEventSequenceConflict(event) {
    console.error(`[run-store] ${EVENT_SEQUENCE_CONFLICT_EVENT}`, event);
  },
};

export function createPostgresRunStore(
  options: RunStoreOptions = {},
): RunStore & AttemptRunStore {
  const securityEvents = options.securityEvents ?? CONSOLE_SECURITY_EVENT_SINK;
  return {
    async enqueueRun(input) {
      const publicId = generateRunPublicId();
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildEnqueueRunSql(publicId, input),
        )) as unknown as Array<{ id: string; public_id: string }>;
        const row = rows[0];
        if (!row)
          throw new Error("run-store: enqueueRun insert returned no row");
        return { runId: row.id, publicId: row.public_id };
      });
    },

    async claimNextRun(workerId, options) {
      // The compatibility dispatcher. With a resolved engine identity it tries
      // the fenced V2 queue first and falls back to V1; without one it can only
      // claim V1 (a V2 attempt row REQUIRES a pinned engine name/version/build
      // digest, so there is no "claim now, resolve later" path). Either way
      // already-enqueued V1 work stays claimable until its later retirement.
      if (options) {
        const v2 = await this.claimNextRunV2(workerId, options);
        if (v2) return v2;
      }
      return this.claimLegacyV1(workerId);
    },

    async claimLegacyV1(workerId) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildClaimNextRunSql(workerId),
        )) as unknown as ClaimedRunRow[];
        const row = rows[0];
        return row ? mapClaimedRunRow(row) : null;
      });
    },

    async renewLease(runId, workerId) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildRenewLeaseSql(runId, workerId),
        )) as unknown as Array<{ id: string }>;
        return rows.length > 0;
      });
    },

    async appendEvents(runId, orgId, workspaceId, events) {
      const query = buildAppendEventsSql(runId, orgId, workspaceId, events);
      if (!query) return; // empty batch — nothing to do, no round-trip.
      await withSystemDb((tx: Tx) => tx.execute(query));
    },

    async readEventsSince(runId, afterSeq, limit) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildReadEventsSinceSql(runId, afterSeq, limit),
        )) as unknown as RunEventRow[];
        return rows.map(mapRunEventRow);
      });
    },

    async saveCheckpoint(runId, workerId, checkpointSeq, checkpoint) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildSaveCheckpointSql(runId, workerId, checkpointSeq, checkpoint),
        )) as unknown as Array<{ id: string }>;
        return rows.length > 0;
      });
    },

    async completeRun(runId, workerId, result) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildCompleteRunSql(runId, workerId, result),
        )) as unknown as Array<{ id: string }>;
        return rows.length > 0;
      });
    },

    async failRun(runId, workerId, error) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildFailRunSql(runId, workerId, error),
        )) as unknown as Array<{ id: string }>;
        return rows.length > 0;
      });
    },

    async cancelRun(runId, workerId) {
      return withSystemDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildCancelRunSql(runId, workerId),
        )) as unknown as Array<{ id: string }>;
        return rows.length > 0;
      });
    },

    async requestCancel(runId) {
      await withTenantDb((tx: Tx) => tx.execute(buildRequestCancelSql(runId)));
    },

    async isCancelRequested(runId) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildIsCancelRequestedSql(runId),
        )) as unknown as Array<{ cancel_requested: boolean }>;
        return Boolean(rows[0]?.cancel_requested);
      });
    },

    async getRunByPublicId(publicId) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildGetRunByPublicIdSql(publicId),
        )) as unknown as RunSummaryRow[];
        const row = rows[0];
        return row ? mapRunSummaryRow(row) : null;
      });
    },

    // ── V2 — fenced immutable attempts ───────────────────────────────────────

    async enqueueRunV2(input) {
      const publicId = generateRunPublicId();
      const specDigest = runSpecV2Digest(input.spec);
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildEnqueueRunV2Sql(publicId, specDigest, input),
        )) as unknown as Array<
          RunV2IdentityRow & { id: string; public_id: string }
        >;
        const row = rows[0];
        if (!row) {
          throw new RunStoreStateError("enqueueRunV2 insert returned no row");
        }
        // Verify what Postgres ACTUALLY stored against the parsed spec —
        // including that the internal uuids admission resolved really do
        // address the public ids the spec pinned (that is what the joins in
        // the query are for). Digest first, then field by field; a mismatch
        // throws inside the transaction, so the run row never survives.
        assertRunRowMatchesSpec(mapRunV2IdentityRow(row), input.spec);
        return { runId: row.id, publicId: row.public_id, specDigest };
      });
    },

    async claimNextRunV2(workerId, options) {
      const leaseSeconds = options.leaseSeconds ?? RUN_LEASE_SECONDS;
      const restorableSchemas = options.restorableEngineStateSchemas ?? [];
      return withSystemDb(async (tx: Tx) => {
        const runRows = (await tx.execute(
          buildLockClaimableRunV2Sql(),
        )) as unknown as ClaimableRunV2Row[];
        const run = runRows[0];
        if (!run) return null;

        // Restore BEFORE creating the attempt: the attempt row carries the
        // complete restore tuple and is immutable once written.
        let restore: RestoredCheckpointRef | null = null;
        if (restorableSchemas.length > 0) {
          const checkpointRows = (await tx.execute(
            buildSelectRestorableCheckpointSql(run.id, restorableSchemas),
          )) as unknown as RestorableCheckpointRow[];
          const checkpoint = checkpointRows[0];
          if (checkpoint) restore = mapRestorableCheckpointRow(checkpoint);
        }

        const attemptNumber = Number(run.attempt_count) + 1;
        const maxAttempts = Number(run.max_attempts);
        if (attemptNumber > maxAttempts) {
          // Belt to the WHERE clause's braces: never retry without a bound.
          throw new RunStoreStateError(
            `run ${run.id} has exhausted its pinned max_attempts (${maxAttempts})`,
          );
        }

        const attemptRows = (await tx.execute(
          buildInsertAttemptSql({
            publicId: generateAttemptPublicId(),
            orgId: run.org_id,
            workspaceId: run.workspace_id,
            runId: run.id,
            attemptNumber,
            workerId,
            engine: options.engine,
            restore,
          }),
        )) as unknown as Array<{
          id: string;
          public_id: string;
          attempt_number: number | string;
        }>;
        const attempt = attemptRows[0];
        if (!attempt) {
          throw new RunStoreStateError(
            `run ${run.id} attempt insert returned no row`,
          );
        }

        const epochRows = (await tx.execute(
          buildSelectNextLeaseEpochSql(run.id),
        )) as unknown as Array<{ next_epoch: number | string }>;
        const leaseEpoch = Number(epochRows[0]?.next_epoch ?? 1);
        const leaseToken = generateLeaseToken();

        await tx.execute(
          buildInsertAttemptLeaseSql({
            orgId: run.org_id,
            workspaceId: run.workspace_id,
            runId: run.id,
            attemptId: attempt.id,
            leaseToken,
            leaseEpoch,
            workerId,
            leaseSeconds,
          }),
        );

        const claimed = (await tx.execute(
          buildMarkRunClaimedV2Sql(run.id, workerId, attempt.id, leaseSeconds),
        )) as unknown as Array<{ id: string }>;
        if (claimed.length === 0) {
          throw new RunStoreStateError(
            `run ${run.id} could not be marked running`,
          );
        }

        return mapClaimedRunV2(
          run,
          attempt,
          { leaseToken, leaseEpoch },
          options.engine,
          restore,
        );
      });
    },

    async renewAttemptLease(lease, leaseSeconds = RUN_LEASE_SECONDS) {
      return withSystemDb(async (tx: Tx) => {
        const leaseRows = (await tx.execute(
          buildLockAttemptLeaseSql(lease.attemptId),
        )) as unknown as LockedLeaseRow[];
        assertLeaseUsable(leaseRows[0], lease);
        const rows = (await tx.execute(
          buildRenewAttemptLeaseSql(lease, leaseSeconds),
        )) as unknown as Array<{ expires_at: string | Date }>;
        const row = rows[0];
        if (!row) throw new RunLeaseFencedError(lease.attemptId, "fenced");
        return { expiresAt: toDate(row.expires_at) };
      });
    },

    async isAttemptCancelRequested(lease) {
      return withSystemDb(async (tx: Tx) => {
        const leaseRows = (await tx.execute(
          buildLockAttemptLeaseSql(lease.attemptId),
        )) as unknown as LockedLeaseRow[];
        // Gated on the same fencing tuple as a write: a fenced attempt has no
        // standing to ask whether it should keep going — it must stop either
        // way, and answering "not cancelled" would tell it to continue.
        assertLeaseUsable(leaseRows[0], lease);
        const rows = (await tx.execute(
          buildIsAttemptCancelRequestedSql(lease.attemptId),
        )) as unknown as Array<{ cancel_requested: boolean }>;
        return Boolean(rows[0]?.cancel_requested);
      });
    },

    async appendAttemptBatch(input) {
      // Validate every payload BEFORE opening a transaction: an unknown event
      // type or a smuggled raw field must fail without ever reaching SQL.
      const prepared = input.events.map(prepareAttemptEvent);
      let conflictScope: {
        orgId: string;
        workspaceId: string;
        runId: string;
      } | null = null;
      try {
        return await withSystemDb(async (tx: Tx) => {
          const leaseRows = (await tx.execute(
            buildLockAttemptLeaseSql(input.lease.attemptId),
          )) as unknown as LockedLeaseRow[];
          const leaseRow = assertLeaseUsable(leaseRows[0], input.lease);
          conflictScope = {
            orgId: leaseRow.org_id,
            workspaceId: leaseRow.workspace_id,
            runId: leaseRow.run_id,
          };
          return appendPreparedBatchInTx(
            tx,
            input.lease,
            leaseRow,
            prepared,
            input.checkpoint,
          );
        });
      } catch (err) {
        // Reported AFTER the transaction rolled back, deliberately: a sink
        // writing inside that transaction would have its audit row rolled back
        // together with the conflicting append, erasing the one record this
        // requirement exists to create.
        if (err instanceof RunEventIntegrityError && conflictScope !== null) {
          const scope: { orgId: string; workspaceId: string; runId: string } =
            conflictScope;
          await securityEvents.recordEventSequenceConflict({
            type: EVENT_SEQUENCE_CONFLICT_EVENT,
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            runId: scope.runId,
            attemptId: err.attemptId,
            attemptPublicId: input.lease.attemptPublicId,
            attemptSeq: err.attemptSeq,
            storedDigest: err.storedDigest,
            incomingDigest: err.incomingDigest,
          });
        }
        throw err;
      }
    },

    async sealAttempt(input) {
      if (input.terminalStatus === "abandoned") {
        throw new RunStoreStateError(
          "abandoned is the reclaimer's terminal status; a worker cannot seal " +
            "its own attempt as abandoned",
        );
      }
      const terminalEvent = input.terminalEvent
        ? prepareAttemptEvent(input.terminalEvent)
        : null;
      if (terminalEvent && !isTerminalEventType(terminalEvent.eventType)) {
        throw new RunStoreStateError(
          `event type ${terminalEvent.eventType} is not a terminal-stage event`,
        );
      }

      return withSystemDb(async (tx: Tx) => {
        const leaseRows = (await tx.execute(
          buildLockAttemptLeaseSql(input.lease.attemptId),
        )) as unknown as LockedLeaseRow[];
        const rejection = leaseRejectionReason(leaseRows[0], input.lease);
        // A duplicate seal returns the SAME handle — above all the same
        // submission id — rather than minting a second grant.
        if (rejection === "sealed") {
          return readSealedHandleInTx(tx, input.lease);
        }
        const leaseRow = assertLeaseUsable(leaseRows[0], input.lease);

        const appendResult = terminalEvent
          ? await appendPreparedBatchInTx(
              tx,
              input.lease,
              leaseRow,
              [terminalEvent],
              undefined,
            )
          : null;

        const eventCount = appendResult
          ? appendResult.eventCount
          : Number(leaseRow.event_count);
        const eventStreamDigest = appendResult
          ? appendResult.eventStreamDigest
          : (leaseRow.event_stream_digest ?? EMPTY_EVENT_STREAM_DIGEST);
        const finalEventDigest = appendResult
          ? appendResult.finalEventDigest
          : (leaseRow.final_event_digest ?? null);
        const finalRunSeq =
          eventCount > 0
            ? (appendResult?.lastRunSeq ?? String(leaseRow.last_run_seq))
            : null;
        const finalAttemptSeq =
          eventCount > 0
            ? (appendResult?.lastAttemptSeq ??
              Number(leaseRow.last_attempt_seq))
            : null;

        const handle = await sealAttemptInTx(tx, {
          lease: input.lease,
          leaseRow,
          terminalStatus: input.terminalStatus,
          reasonCode: input.reasonCode ?? null,
          eventCount,
          finalRunSeq,
          finalAttemptSeq,
          finalEventDigest,
          eventStreamDigest,
          sealerKind: "worker",
          sealerWorkerId: input.sealerWorkerId,
        });

        await tx.execute(
          buildFinishRunV2Sql(
            leaseRow.run_id,
            runStatusForTerminal(input.terminalStatus),
            input.result ?? null,
            input.error ?? null,
          ),
        );

        return handle;
      });
    },

    async reclaimExpiredAttempts(options) {
      const limit = options.limit ?? DEFAULT_RECLAIM_LIMIT;
      const candidates = (await withSystemDb((tx: Tx) =>
        tx.execute(buildSelectExpiredAttemptLeasesSql(limit)),
      )) as unknown as Array<{
        attempt_id: string;
        run_id: string;
        lease_token: string;
        lease_epoch: number | string;
        attempt_public_id: string;
        attempt_number: number | string;
        max_attempts: number | string;
        attempt_count: number | string;
      }>;

      const reclaimed: ReclaimedAttempt[] = [];
      for (const candidate of candidates) {
        const lease: RunLeaseRef = {
          runId: candidate.run_id,
          attemptId: candidate.attempt_id,
          attemptPublicId: candidate.attempt_public_id,
          leaseToken: candidate.lease_token,
          leaseEpoch: Number(candidate.lease_epoch),
        };
        const maxAttempts = Number(candidate.max_attempts);
        const attemptCount = Number(candidate.attempt_count);
        const successorPermitted = attemptCount < maxAttempts;

        // One transaction PER attempt: a single poisoned row must not roll
        // back every other seal the sweep already committed.
        const result = await withSystemDb(async (tx: Tx) => {
          const leaseRows = (await tx.execute(
            buildLockAttemptLeaseSql(lease.attemptId),
          )) as unknown as LockedLeaseRow[];
          const rejection = leaseRejectionReason(leaseRows[0], lease, {
            allowExpired: true,
          });
          if (rejection === "sealed") {
            // Another sweeper won the race; return its handle unchanged and do
            // NOT re-mutate the run it already requeued or failed.
            return {
              handle: await readSealedHandleInTx(tx, lease),
              alreadyHandled: true,
            };
          }
          if (rejection !== null) return null;
          const leaseRow = leaseRows[0] as LockedLeaseRow;

          // The zero-event path. `event_count = 0` means NOTHING was ever
          // accepted from this attempt: it seals with a null final-event digest
          // and the canonical empty-stream digest, and synthesizes no terminal
          // event. Inventing one would put an observation in the ledger that
          // no producer ever made.
          const eventCount = Number(leaseRow.event_count);
          const hasEvents = eventCount > 0;

          const handle = await sealAttemptInTx(tx, {
            lease,
            leaseRow,
            terminalStatus: "abandoned",
            reasonCode: options.reasonCode ?? "lease_expired",
            eventCount,
            finalRunSeq: hasEvents ? String(leaseRow.last_run_seq) : null,
            finalAttemptSeq: hasEvents
              ? Number(leaseRow.last_attempt_seq)
              : null,
            finalEventDigest: hasEvents
              ? (leaseRow.final_event_digest ?? null)
              : null,
            eventStreamDigest: hasEvents
              ? (leaseRow.event_stream_digest ?? EMPTY_EVENT_STREAM_DIGEST)
              : EMPTY_EVENT_STREAM_DIGEST,
            sealerKind: "reclaimer",
            sealerWorkerId: options.reclaimerWorkerId,
          });

          // The successor attempt is created by the NEXT claim, not here: an
          // attempt row pins a resolved engine build digest that only a
          // claiming worker knows. Seal + grant + obligation are already
          // durable at this point, so evidence cannot be stranded either way.
          if (successorPermitted) {
            await tx.execute(buildRequeueRunForSuccessorSql(leaseRow.run_id));
          } else {
            await tx.execute(
              buildFinishRunV2Sql(
                leaseRow.run_id,
                "failed",
                null,
                `run exhausted its pinned max_attempts (${maxAttempts})`,
              ),
            );
          }
          return { handle, alreadyHandled: false };
        });

        if (result) {
          reclaimed.push({
            handle: result.handle,
            runId: candidate.run_id,
            attemptNumber: Number(candidate.attempt_number),
            maxAttempts,
            successorPermitted,
          });
        }
      }
      return reclaimed;
    },

    async readAttemptEventsSince(runId, afterRunSeq, limit) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildReadAttemptEventsSinceSql(runId, afterRunSeq, limit),
        )) as unknown as Parameters<typeof mapAttemptEventReadRow>[0][];
        return rows.map(mapAttemptEventReadRow);
      });
    },
  };
}
