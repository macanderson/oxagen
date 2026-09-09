/**
 * The run evidence ledger — the ONLY writer of `agent.agent_runs`,
 * `agent.agent_run_events`, `agent.agent_run_attempts`,
 * `agent.agent_run_attempt_seals`, `agent.agent_run_finalization_grants` and
 * `agent.agent_run_finalization_obligations`
 * (docs/specs/run-evidence-ingress/spec.md; ADR-043).
 *
 * Nothing here executes an agent. ADR-043 removed the durable worker that used
 * to claim runs, lease them, checkpoint engine state and reclaim expired
 * attempts, along with the two tables that existed only to support it
 * (`agent_run_checkpoints`, `agent_run_attempt_leases`). What remains is the
 * evidence chain an external engine's drain submits and Oxagen stamps:
 *
 *   run (trusted RunSpecV2 identity)
 *     └─ attempt (immutable, `arat_…`, pinned engine name/version/build digest)
 *          └─ events (append-only, dual `run_seq`/`attempt_seq`, digest-chained)
 *               └─ seal (one per attempt, every terminal outcome)
 *                    └─ finalization grant + durable obligation (one shot each)
 *
 * ## Why there is no mutable progress pointer any more
 *
 * The lease row used to carry `last_attempt_seq`, `event_count`,
 * `final_event_digest` and the running `event_stream_digest`. It is gone, and
 * it is deliberately NOT replaced by an equivalent column elsewhere: the
 * append-only event log is now the single authority for an attempt's position
 * in its own stream. `readAttemptState()` reads the attempt's durable rows and
 * folds them (`foldAttemptEventState`), so a pointer can never disagree with
 * the log it claims to summarize — the exact failure the old
 * "lease reports seq N committed but no event row exists" branch guarded
 * against. Serialization comes from the run row's `FOR UPDATE` lock, which the
 * `next_run_seq` allocator needs anyway.
 *
 * ## Fencing, without a lease
 *
 * A seal is the fence. `assertAttemptWritable` refuses an append or a second
 * seal on a sealed attempt (`AttemptNotWritableError`), and the append itself
 * carries the integrity invariants that make the stream provable:
 *
 *  - `attempt_seq` is producer-assigned and DENSE from 1. A gap — inside the
 *    batch, or between the batch and the durable log — is refused
 *    (`RunEventSequenceGapError`) rather than repaired; accepting it would
 *    ratify a loss that already happened.
 *  - A re-sent prefix is idempotent ONLY when every digest matches. The same
 *    `(attempt_id, attempt_seq)` with a DIFFERENT digest is a hard integrity
 *    failure (`RunEventIntegrityError`) plus a security event emitted AFTER the
 *    transaction rolls back — never an `ON CONFLICT DO NOTHING`, which is
 *    precisely how such a conflict would disappear.
 *  - The insert has no conflict clause at all: a unique violation there means
 *    two writers raced past the run lock, and that must surface.
 *
 * ## Tenancy
 *
 * Every method runs under `withTenantDb`, so RLS from the caller's ambient
 * tenant scope is the tenant filter. That is now the whole story: the
 * cross-tenant `withSystemDb` paths in this module existed for the worker pool
 * and the lease sweeper, and both left with ADR-043. Evidence ingress reaches
 * this store through `kernel.invoke()`, which always establishes scope.
 *
 * Every SQL-building and row-mapping decision is a pure, exported function —
 * unit-testable without a database (run-store.test.ts drives the store methods
 * through `makeWithTenantDbMock`).
 */
import { sql, type SQL } from "drizzle-orm";
import { withTenantDb, type Tx } from "@oxagen/database";
import type { PlatformSurface } from "./surface";
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
  AttemptNotWritableError,
  RunEventIntegrityError,
  RunEventSequenceGapError,
  RunStoreStateError,
  type AttemptRejectionReason,
} from "./run-errors";

/** Default page size for the resumable event read when the caller omits one. */
export const DEFAULT_READ_EVENTS_LIMIT = 500;

/**
 * The security-event type emitted when the same `(attempt_id, attempt_seq)`
 * arrives twice with different digests. Mirrors the spelling registered in
 * `SECURITY_EVENT_TYPES` (@oxagen/compliance); this constant is the single
 * source both sides read.
 */
export const EVENT_SEQUENCE_CONFLICT_EVENT =
  "agent_run.event_sequence_conflict";

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * Trusted run admission. `spec` is ALREADY parsed — the ledger never accepts an
 * unvalidated body — and the two `*RowId` fields are the INTERNAL uuids
 * admission resolved for the public ids the spec pins. Both kinds are required
 * because the run row stores those bindings as uuid foreign keys while the spec
 * (a wire contract) carries their public ids; `createRun` proves the pair
 * actually agree by joining the inserted row back to the binding/policy rows
 * and comparing what Postgres stored against the spec.
 */
export interface CreateRunInput {
  orgId: string;
  workspaceId: string;
  surface: PlatformSurface;
  spec: RunSpecV2;
  /** Internal uuid of `context_policy.retention_policy_id`'s version row. */
  retentionPolicyRowId: string;
  /** Internal uuid of the pinned repository binding; null for a general run. */
  repositoryBindingRowId: string | null;
}

/** The engine binary that actually executed — pinned on the attempt row. */
export interface ResolvedEngineIdentity {
  name: string;
  version: string;
  /** `sha256:…` build or container-image digest. */
  buildDigest: string;
}

/**
 * Provenance of a successor attempt: which earlier attempt of the same run it
 * resumed. The successor keeps its OWN attempt identity — attempt ids are never
 * reused (spec.md §"Attempt identity"). The checkpoint half of this tuple went
 * with `agent.agent_run_checkpoints` in ADR-043: Oxagen restores no engine
 * state, so only the provenance chain remains as evidence.
 */
export interface AttemptProvenance {
  attemptId: string;
  attemptPublicId: string;
}

/**
 * Create one immutable attempt on an existing run.
 *
 * `producerId` is the identity of the process that produced this attempt's
 * evidence (an external engine's drain, a wrapper SDK submission). It is stored
 * in the legacy-named `worker_id` column, which predates ADR-043.
 */
export interface CreateAttemptInput {
  runId: string;
  producerId: string;
  engine: ResolvedEngineIdentity;
  resumedFrom?: AttemptProvenance;
}

/** A newly created attempt, as `createAttempt` returns it. */
export interface CreatedAttempt {
  attemptId: string;
  attemptPublicId: string;
  runId: string;
  orgId: string;
  workspaceId: string;
  attemptNumber: number;
  maxAttempts: number;
  engine: ResolvedEngineIdentity;
  resumedFrom: AttemptProvenance | null;
}

/**
 * One event as a producer emits it. Exactly one of `payload` (inline,
 * allow-listed receipt metadata) or `encryptedPayloadRef` + `payloadDigest` (a
 * tenant-encrypted blob) — mirroring the table's own
 * `(payload_inline IS NULL) <> (encrypted_payload_ref IS NULL)` CHECK.
 *
 * `observedAt` is the PRODUCER's observation time and is inside `event_digest`.
 * A replayed batch MUST resend the original value: re-stamping the clock
 * changes the digest and turns a benign retry into a hard integrity conflict.
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

export interface AppendAttemptBatchInput {
  attemptId: string;
  events: readonly AttemptEventInput[];
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
}

/** One event as a reader (resumable subscription, replay) projects it. */
export interface AttemptEventReadRecord {
  eventId: string;
  attemptId: string;
  attemptPublicId: string;
  /**
   * Run-global sequence as an exact DECIMAL STRING. `run_seq` is a Postgres
   * bigint and a subscription cursor is text — carrying it as a JS number would
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
  attemptId: string;
  terminalStatus: AttemptTerminalStatus;
  reasonCode?: string;
  /**
   * The terminal event, appended and validated in the SAME transaction as the
   * seal. Omitted when the attempt already appended its terminal event, and for
   * a zero-event abandoned attempt — which seals with a null final-event digest
   * and the canonical empty-stream digest rather than inventing an observation
   * no producer ever made.
   */
  terminalEvent?: AttemptEventInput;
  /** Identity of the process recording the seal (legacy `sealer_worker_id`). */
  sealerId: string;
  /** Recorded on `agent_runs.error` for a failed run. */
  error?: string;
  /** Recorded on `agent_runs.result` for a completed run. */
  result?: unknown;
}

/**
 * Where a same-sequence/different-digest conflict is reported. Injected rather
 * than imported so this package keeps its narrow dependency set and so the sink
 * can be a real @oxagen/compliance writer, an Inngest emit, or a test spy.
 *
 * It is called OUTSIDE the append transaction, after the rollback: a sink that
 * wrote inside that transaction would have its audit row rolled back together
 * with the conflicting append, erasing the exact record this requirement exists
 * to create.
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
   * a trace until the real sink is wired.
   */
  securityEvents?: RunSecurityEventSink;
}

// ── Read projections ─────────────────────────────────────────────────────────

/**
 * Public, tenant-facing run status. Deliberately carries no execution state:
 * the ledger's read side answers "what is on the record for this run", not
 * "where is the worker up to".
 */
export interface RunSummary {
  runId: string;
  publicId: string;
  surface: string;
  /**
   * Which event-record contract this run's log obeys: `1` = preserved legacy
   * run-global `seq`, `2` = fenced attempts cursored on the decimal `run_seq`.
   * Part of the PUBLIC projection, not an internal detail: a resumable
   * subscriber cannot pick a cursor without it, and the two cursors are not
   * interchangeable.
   */
  specVersion: 1 | 2;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: unknown | null;
  error: string | null;
  /** Attempts ever created for this run. Null on a preserved legacy row. */
  attemptCount: number;
  /** The pinned attempt ceiling. Null on a preserved legacy row. */
  maxAttempts: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** One immutable attempt, as the read side projects it. */
export interface AttemptRecord {
  attemptId: string;
  attemptPublicId: string;
  runId: string;
  attemptNumber: number;
  producerId: string;
  engine: ResolvedEngineIdentity;
  resumedFrom: AttemptProvenance | null;
  claimedAt: Date;
  /** Present once the attempt is sealed; null while it is still open. */
  seal: AttemptSealRecord | null;
}

/** The immutable terminal record of one attempt. */
export interface AttemptSealRecord {
  sealId: string;
  terminalStatus: string;
  reasonCode: string | null;
  eventCount: number;
  finalRunSeq: string | null;
  finalAttemptSeq: number | null;
  finalEventDigest: string | null;
  eventStreamDigest: string;
  sealedAt: Date;
}

// ── The store surface ────────────────────────────────────────────────────────

export interface RunStore {
  /**
   * Admit a run from a trusted `RunSpecV2` and verify every typed column
   * against the spec before the transaction commits.
   */
  createRun(
    input: CreateRunInput,
  ): Promise<{ runId: string; publicId: string; specDigest: string }>;

  /**
   * Create one immutable attempt, bounded by the run's pinned `max_attempts`.
   * The engine identity is pinned here, before any evidence may be appended.
   */
  createAttempt(input: CreateAttemptInput): Promise<CreatedAttempt>;

  /**
   * Append a contiguous batch of events to an open attempt in one transaction,
   * allocating run-global sequences from the run row's `next_run_seq`.
   */
  appendAttemptBatch(
    input: AppendAttemptBatchInput,
  ): Promise<AppendAttemptBatchResult>;

  /**
   * Seal a terminal attempt: optionally append and validate its terminal event,
   * insert the immutable seal, mint the non-expiring one-shot finalization
   * grant and its durable obligation, and drive the run to its terminal
   * status — all atomically. Sealing an already-sealed attempt is idempotent
   * and returns the SAME handle, above all the same `submission_id`.
   */
  sealAttempt(input: SealAttemptInput): Promise<SealedAttemptHandle>;

  /**
   * Look up a run's public projection by its `arun_…` public id. Tenant-scoped
   * through RLS, so a cross-tenant public id resolves to `null`, never another
   * org's row.
   */
  getRunByPublicId(publicId: string): Promise<RunSummary | null>;

  /** Every attempt of a run, oldest first, each with its seal when sealed. */
  listRunAttempts(runId: string): Promise<AttemptRecord[]>;

  /** The attempt's folded position in its own stream, read from the log. */
  readAttemptState(attemptId: string): Promise<AttemptEventState>;

  /** Resumable event read, cursored on the decimal `run_seq`. */
  readAttemptEventsSince(
    runId: string,
    afterRunSeq: string,
    limit?: number,
  ): Promise<AttemptEventReadRecord[]>;

  /**
   * The finalization handle for a sealed attempt — the grant and obligation the
   * finalizer presents to `ingest_run_evidence`. Null while the attempt is open.
   */
  getFinalizationHandle(attemptId: string): Promise<SealedAttemptHandle | null>;
}

// ── Pure helpers — id generation + row mapping ───────────────────────────────

/**
 * Mint a public id for a new run: a fixed prefix plus 22 hex chars sliced from
 * a UUIDv4 with its dashes stripped — collision-safe without a DB round-trip.
 */
export function generateRunPublicId(): string {
  return `arun_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

export { generateAttemptPublicId };

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: string | Date | null): Date | null {
  return value === null ? null : toDate(value);
}

/**
 * The exact typed identity a run admission must write, derived from the parsed
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

/** Typed columns a run row returns, joined to the two bindings' public ids. */
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

/** Driver-typed `agent_runs` row behind the public `RunSummary`. */
export interface RunSummaryRow {
  id: string;
  public_id: string;
  surface: string;
  spec_version?: number | string | null;
  status: string;
  result: unknown | null;
  error: string | null;
  attempt_count: number | string;
  max_attempts: number | string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
}

/** Map an `agent_runs` row (snake_case, driver-typed) to the public summary. */
export function mapRunSummaryRow(row: RunSummaryRow): RunSummary {
  return {
    runId: row.id,
    publicId: row.public_id,
    surface: row.surface,
    // Anything that is not EXACTLY 2 reads as legacy v1 — the fail-closed
    // direction. A subscriber that mistakes a v2 run for v1 cursors on `seq`,
    // which is NULL on every v2 event row and therefore yields nothing;
    // mistaking v1 for v2 would hand a caller a `run_seq` cursor no v1 row can
    // satisfy.
    specVersion: Number(row.spec_version) === 2 ? 2 : 1,
    status: row.status as RunSummary["status"],
    result: row.result ?? null,
    error: row.error ?? null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: row.max_attempts === null ? null : Number(row.max_attempts),
    createdAt: toDate(row.created_at),
    startedAt: toDateOrNull(row.started_at),
    completedAt: toDateOrNull(row.completed_at),
  };
}

/** Driver-typed attempt row, left-joined to its seal. */
export interface AttemptRow {
  id: string;
  public_id: string;
  run_id: string;
  attempt_number: number | string;
  worker_id: string;
  engine_name: string;
  engine_version: string;
  engine_build_digest: string;
  resumed_from_attempt_id: string | null;
  resumed_from_attempt_public_id: string | null;
  claimed_at: string | Date;
  seal_id: string | null;
  terminal_status: string | null;
  reason_code: string | null;
  event_count: number | string | null;
  final_run_seq: string | null;
  final_attempt_seq: number | string | null;
  final_event_digest: string | null;
  event_stream_digest: string | null;
  sealed_at: string | Date | null;
}

/** Map one attempt row (with its optional seal) to the public projection. */
export function mapAttemptRow(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.id,
    attemptPublicId: row.public_id,
    runId: row.run_id,
    attemptNumber: Number(row.attempt_number),
    producerId: row.worker_id,
    engine: {
      name: row.engine_name,
      version: row.engine_version,
      buildDigest: row.engine_build_digest,
    },
    resumedFrom:
      row.resumed_from_attempt_id !== null &&
      row.resumed_from_attempt_public_id !== null
        ? {
            attemptId: row.resumed_from_attempt_id,
            attemptPublicId: row.resumed_from_attempt_public_id,
          }
        : null,
    claimedAt: toDate(row.claimed_at),
    seal:
      row.seal_id !== null && row.event_stream_digest !== null
        ? {
            sealId: row.seal_id,
            terminalStatus: row.terminal_status ?? "",
            reasonCode: row.reason_code ?? null,
            eventCount: Number(row.event_count ?? 0),
            finalRunSeq:
              row.final_run_seq === null ? null : String(row.final_run_seq),
            finalAttemptSeq:
              row.final_attempt_seq === null
                ? null
                : Number(row.final_attempt_seq),
            finalEventDigest: row.final_event_digest ?? null,
            eventStreamDigest: row.event_stream_digest,
            sealedAt: toDate(row.sealed_at ?? row.claimed_at),
          }
        : null,
  };
}

// ── Event preparation, batch planning, and the folded stream state ───────────

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
 * Validate one event against the closed registry and compute its digests.
 * Throws for an unknown type, a forbidden inline field, an oversized payload,
 * or a malformed encrypted reference — all BEFORE any SQL exists.
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
  /** Sequences already durable — candidates for idempotent reuse. */
  replays: PreparedAttemptEvent[];
  /** Sequences past the durable tail — genuinely new rows. */
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
 * A batch that starts at or below the durable tail is a crash retry: those
 * events are digest-compared by `reconcileReplayedEvents`, never blindly
 * re-inserted.
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

/** The minimum an already-durable event row must carry to be reconciled. */
export interface ExistingAttemptEventRow {
  id: string;
  attempt_seq: number | string;
  run_seq: number | string;
  event_digest: string;
}

/**
 * A durable event row as the attempt-state read returns it: everything
 * `reconcileReplayedEvents` needs, plus the three fields the stream digest
 * commits to.
 */
export interface AttemptEventStateRow extends ExistingAttemptEventRow {
  event_schema_version: string;
  event_type: string;
  payload_digest: string;
}

/**
 * Reconcile a replayed prefix against what is already durable.
 *
 * Identical digest ⇒ the prior row and its run sequence are returned unchanged
 * (the crash-retry case). A DIFFERENT digest for the same sequence is never
 * dropped: it means two producers observed different executions of the same
 * position, so the ordered stream is no longer one provable history. That
 * throws `RunEventIntegrityError`, which the caller reports through the
 * security-event sink AFTER the transaction rolls back. `ON CONFLICT DO
 * NOTHING` would hide exactly this, which is why the insert has no conflict
 * clause at all.
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
      throw new RunStoreStateError(
        `attempt ${attemptId} has no durable event row for seq ${event.attemptSeq}`,
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
 * already inside `previousDigest` — folding them twice would move the digest on
 * every retry and make a sealed attempt un-verifiable.
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

/**
 * An attempt's position in its own stream, derived from the durable log rather
 * than read off a mutable pointer. `eventStreamDigest` is the canonical
 * empty-stream sentinel for a zero-event attempt — "no events" is itself a
 * provable claim about the stream, not an absence of one.
 */
export interface AttemptEventState {
  eventCount: number;
  lastAttemptSeq: number;
  /** `"0"` for a zero-event attempt. */
  lastRunSeq: string;
  finalEventDigest: string | null;
  eventStreamDigest: string;
}

/**
 * Fold an attempt's durable event rows into its stream state, asserting the
 * log's own invariant on the way through: `attempt_seq` is dense from 1. A hole
 * in what is already committed is unrecoverable state, not something to
 * summarize — `RunStoreStateError` rather than a plausible-looking digest.
 *
 * Rows must arrive ordered by `attempt_seq`; the query orders them.
 */
export function foldAttemptEventState(
  attemptId: string,
  rows: readonly AttemptEventStateRow[],
): AttemptEventState {
  let digest = EMPTY_EVENT_STREAM_DIGEST;
  let lastAttemptSeq = 0;
  let lastRunSeq = "0";
  let finalEventDigest: string | null = null;

  for (const row of rows) {
    const attemptSeq = Number(row.attempt_seq);
    if (attemptSeq !== lastAttemptSeq + 1) {
      throw new RunStoreStateError(
        `attempt ${attemptId} has a hole in its durable event log: expected ` +
          `seq ${lastAttemptSeq + 1}, found ${attemptSeq}`,
      );
    }
    digest = advanceEventStreamDigest(digest, {
      attemptSeq,
      eventSchemaVersion: row.event_schema_version,
      eventType: row.event_type,
      payloadDigest: row.payload_digest,
    });
    lastAttemptSeq = attemptSeq;
    lastRunSeq = String(row.run_seq);
    finalEventDigest = row.event_digest;
  }

  return {
    eventCount: rows.length,
    lastAttemptSeq,
    lastRunSeq,
    finalEventDigest,
    eventStreamDigest: digest,
  };
}

// ── Attempt writability ──────────────────────────────────────────────────────

/** The locked attempt row plus everything a write gate must check. */
export interface LockedAttemptRow {
  attempt_id: string;
  attempt_public_id: string;
  run_id: string;
  org_id: string;
  workspace_id: string;
  attempt_number: number | string;
  seal_id: string | null;
}

/**
 * Why a write against an attempt must be refused, or `null` when it may
 * proceed. Returned rather than thrown so `sealAttempt` can recognize its own
 * idempotent duplicate (`"sealed"`) instead of failing on it.
 */
export function attemptRejectionReason(
  row: LockedAttemptRow | undefined,
): AttemptRejectionReason | null {
  if (!row) return "unknown_attempt";
  // A seal is the fence: once it exists the attempt's stream is committed to,
  // and any later write would be appending to evidence that is already sealed.
  if (row.seal_id !== null) return "sealed";
  return null;
}

/** Throwing form of `attemptRejectionReason`, used by every append. */
export function assertAttemptWritable(
  attemptId: string,
  row: LockedAttemptRow | undefined,
): LockedAttemptRow {
  const reason = attemptRejectionReason(row);
  if (reason !== null) throw new AttemptNotWritableError(attemptId, reason);
  return row as LockedAttemptRow;
}

/** Run status a terminal attempt drives its run to. */
export function runStatusForTerminal(
  terminalStatus: AttemptTerminalStatus,
): "completed" | "failed" | "cancelled" {
  if (terminalStatus === "completed") return "completed";
  if (terminalStatus === "cancelled") return "cancelled";
  // `denied` is a failure of the run, not a separate run status — the DENIAL
  // itself is evidence on the sealed attempt. `abandoned` likewise.
  return "failed";
}

// ── SQL builders — pure, exported, unit-testable without a database ─────────

/**
 * Insert the trusted run row and read back what Postgres stored, joined to the
 * repository-binding and retention-policy rows the internal uuids address. The
 * join IS the verification: it turns "the caller says this uuid is that public
 * id" into "the database agrees", which `assertRunRowMatchesSpec` then checks
 * against the spec.
 */
export function buildCreateRunSql(
  publicId: string,
  specDigest: string,
  input: CreateRunInput,
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
 * Lock the run row a new attempt will be created against and project what the
 * attempt row needs. `FOR UPDATE` serializes concurrent attempt creation on one
 * run, so `attempt_count + 1` cannot be computed twice — and if it somehow
 * were, `agent_run_attempts_run_attempt_uq` rejects the second.
 */
export function buildLockRunForAttemptSql(runId: string): SQL {
  return sql`
    SELECT id, org_id, workspace_id, spec_version, status, attempt_count, max_attempts
    FROM agent.agent_runs
    WHERE id = ${runId}::uuid
    FOR UPDATE
  `;
}

export interface InsertAttemptInput {
  publicId: string;
  orgId: string;
  workspaceId: string;
  runId: string;
  attemptNumber: number;
  producerId: string;
  engine: ResolvedEngineIdentity;
  resumedFrom: AttemptProvenance | null;
}

/**
 * Create the immutable attempt. The restore tuple is the attempt-provenance
 * PAIR only — the checkpoint half of it went with `agent_run_checkpoints` in
 * ADR-043, and `agent_run_attempts_restore_tuple_check` now enforces the
 * narrowed all-or-nothing pair.
 */
export function buildInsertAttemptSql(input: InsertAttemptInput): SQL {
  const resumedFrom = input.resumedFrom;
  return sql`
    INSERT INTO agent.agent_run_attempts (
      public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
      engine_name, engine_version, engine_build_digest,
      resumed_from_attempt_id, resumed_from_attempt_public_id
    )
    VALUES (
      ${input.publicId},
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptNumber},
      ${input.producerId},
      ${input.engine.name},
      ${input.engine.version},
      ${input.engine.buildDigest},
      ${resumedFrom?.attemptId ?? null}::uuid,
      ${resumedFrom?.attemptPublicId ?? null}
    )
    RETURNING id, public_id, attempt_number
  `;
}

/**
 * Mark the run in flight and point it at the new attempt. Only operational
 * columns move — the `agent_runs_v2_immutability` trigger rejects any change to
 * the trusted bindings, so this statement cannot rewrite identity by accident.
 */
export function buildMarkRunAttemptedSql(
  runId: string,
  attemptId: string,
): SQL {
  return sql`
    UPDATE agent.agent_runs SET
      status = 'running',
      attempt_count = attempt_count + 1,
      active_attempt_id = ${attemptId}::uuid,
      started_at = coalesce(started_at, now()),
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id, attempt_count
  `;
}

/**
 * Lock an attempt for writing and project its write gate.
 *
 * The lock is taken on the RUN row, not the attempt row: the attempt table is
 * append-only (the migration revokes UPDATE/DELETE, so `FOR UPDATE` on it has
 * no privilege to take), and the run row is what the `next_run_seq` allocator
 * updates anyway. Locking it serializes every append and seal on the run.
 */
export function buildLockAttemptForWriteSql(attemptId: string): SQL {
  return sql`
    WITH locked AS (
      SELECT r.id
      FROM agent.agent_runs r
      WHERE r.id = (
        SELECT run_id FROM agent.agent_run_attempts WHERE id = ${attemptId}::uuid
      )
      FOR UPDATE
    )
    SELECT
      a.id            AS attempt_id,
      a.public_id     AS attempt_public_id,
      a.run_id,
      a.org_id,
      a.workspace_id,
      a.attempt_number,
      s.id            AS seal_id
    FROM agent.agent_run_attempts a
    JOIN locked lk ON lk.id = a.run_id
    LEFT JOIN agent.agent_run_attempt_seals s ON s.attempt_id = a.id
    WHERE a.id = ${attemptId}::uuid
  `;
}

/**
 * Every durable event of one attempt, ordered — the input to
 * `foldAttemptEventState`. Reading the whole stream is the point: the fold both
 * derives the attempt's position and proves the log has no hole, which a stored
 * pointer could only assert.
 */
export function buildSelectAttemptEventStateSql(attemptId: string): SQL {
  return sql`
    SELECT
      id, attempt_seq, run_seq::text AS run_seq,
      event_schema_version, event_type, payload_digest, event_digest
    FROM agent.agent_run_events
    WHERE event_record_version = 2
      AND attempt_id = ${attemptId}::uuid
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
 * Multi-row insert with NO conflict clause. Deliberate: a unique violation on
 * `(attempt_id, attempt_seq)` or `(run_id, run_seq)` here means two writers
 * raced past the run lock, and that must surface as an error rather than vanish.
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
  sealerId: string;
}

/**
 * Insert the immutable seal. `sealer_kind` is `'ingress'` — the one kind Oxagen
 * writes now that ADR-043 removed the runtime: evidence ingress stamps a seal
 * for a submission, it never seals on behalf of a worker it supervised. The
 * column's CHECK still admits the retired `'worker'` and `'reclaimer'` so
 * historical rows stay valid; nothing writes them.
 */
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
      'ingress',
      ${input.sealerId}
    )
    RETURNING id
  `;
}

/** Drive the run to its terminal status and clear the active-attempt pointer. */
export function buildFinishRunSql(
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
      completed_at = now(),
      updated_at = now()
    WHERE id = ${runId}::uuid
    RETURNING id
  `;
}

/**
 * Look up the public status projection by `public_id`. No org/workspace filter —
 * RLS scopes the read from the caller's tenant session.
 */
export function buildGetRunByPublicIdSql(publicId: string): SQL {
  return sql`
    SELECT
      id, public_id, surface, spec_version, status, result, error,
      attempt_count, max_attempts, created_at, started_at, completed_at
    FROM agent.agent_runs
    WHERE public_id = ${publicId}
  `;
}

/** Every attempt of a run, oldest first, each left-joined to its seal. */
export function buildListRunAttemptsSql(runId: string): SQL {
  return sql`
    SELECT
      a.id, a.public_id, a.run_id, a.attempt_number, a.worker_id,
      a.engine_name, a.engine_version, a.engine_build_digest,
      a.resumed_from_attempt_id, a.resumed_from_attempt_public_id, a.claimed_at,
      s.id AS seal_id, s.terminal_status, s.reason_code, s.event_count,
      s.final_run_seq::text AS final_run_seq, s.final_attempt_seq,
      s.final_event_digest, s.event_stream_digest, s.sealed_at
    FROM agent.agent_run_attempts a
    LEFT JOIN agent.agent_run_attempt_seals s ON s.attempt_id = a.id
    WHERE a.run_id = ${runId}::uuid
    ORDER BY a.attempt_number ASC
  `;
}

/** Resumable event read. `run_seq` is projected as text — see the record doc. */
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

/** Driver-typed row behind `AttemptEventReadRecord`. */
export interface AttemptEventReadRow {
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

// ── In-transaction cores ─────────────────────────────────────────────────────

/** Read and fold an attempt's durable stream state inside the caller's tx. */
async function readAttemptStateInTx(
  tx: Tx,
  attemptId: string,
): Promise<{ state: AttemptEventState; rows: AttemptEventStateRow[] }> {
  const rows = (await tx.execute(
    buildSelectAttemptEventStateSql(attemptId),
  )) as unknown as AttemptEventStateRow[];
  return { state: foldAttemptEventState(attemptId, rows), rows };
}

/**
 * Append a prepared batch against an ALREADY LOCKED, already-validated attempt,
 * inside the caller's transaction.
 *
 * Shared by `appendAttemptBatch` and by `sealAttempt`'s terminal-event append,
 * so a terminal event goes through the exact same contiguity, idempotency and
 * digest rules as any other event — a seal cannot smuggle in an event the
 * normal path would have refused.
 */
async function appendPreparedBatchInTx(
  tx: Tx,
  attempt: LockedAttemptRow,
  state: AttemptEventState,
  durable: readonly AttemptEventStateRow[],
  prepared: readonly PreparedAttemptEvent[],
): Promise<AppendAttemptBatchResult> {
  const attemptId = attempt.attempt_id;
  const plan = planAttemptBatch(attemptId, state.lastAttemptSeq, prepared);

  const replayed =
    plan.replays.length > 0
      ? reconcileReplayedEvents(attemptId, plan.replays, durable)
      : [];

  let appended: AppendedAttemptEvent[] = [];
  if (plan.appends.length > 0) {
    const allocated = (await tx.execute(
      buildAllocateRunSeqSql(attempt.run_id, plan.appends.length),
    )) as unknown as Array<{ first_run_seq: string }>;
    const firstRunSeq = allocated[0]?.first_run_seq;
    if (firstRunSeq === undefined) {
      throw new RunStoreStateError(
        `run ${attempt.run_id} did not allocate run sequences`,
      );
    }
    const base = BigInt(firstRunSeq);
    const rows: AttemptEventInsertRow[] = plan.appends.map((event, index) => ({
      ...event,
      runSeq: (base + BigInt(index)).toString(),
    }));
    const insert = buildInsertAttemptEventsSql(
      attempt.run_id,
      attempt.org_id,
      attempt.workspace_id,
      attemptId,
      rows,
    );
    const returned = (await tx.execute(insert as SQL)) as unknown as Array<{
      id: string;
      attempt_seq: number | string;
      run_seq: string;
    }>;
    // Multi-row RETURNING order is not guaranteed, so match on attempt_seq
    // rather than on position.
    const bySeq = new Map(returned.map((r) => [Number(r.attempt_seq), r]));
    appended = rows.map((row) => {
      const got = bySeq.get(row.attemptSeq);
      if (!got) {
        throw new RunStoreStateError(
          `attempt ${attemptId} seq ${row.attemptSeq} was not returned by the insert`,
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

  const lastAppended =
    appended.length > 0
      ? (appended[appended.length - 1] as AppendedAttemptEvent)
      : null;

  // A batch that only replays an older prefix leaves the stream exactly where
  // it was: the durable log, not this batch, is what the state describes.
  return {
    events: [...replayed, ...appended],
    lastAttemptSeq: lastAppended
      ? lastAppended.attemptSeq
      : state.lastAttemptSeq,
    lastRunSeq: lastAppended ? lastAppended.runSeq : state.lastRunSeq,
    eventCount: state.eventCount + appended.length,
    eventStreamDigest: foldAttemptStreamDigest(
      state.eventStreamDigest,
      plan.appends,
    ),
    finalEventDigest: lastAppended
      ? lastAppended.eventDigest
      : state.finalEventDigest,
  };
}

interface SealTransactionInput {
  attempt: LockedAttemptRow;
  terminalStatus: AttemptTerminalStatus;
  reasonCode: string | null;
  eventCount: number;
  finalRunSeq: string | null;
  finalAttemptSeq: number | null;
  finalEventDigest: string | null;
  eventStreamDigest: string;
  sealerId: string;
}

/**
 * Seal, mint the grant, and enqueue the obligation — the three writes that MUST
 * share one transaction. If any fails, none of them happened: a seal without
 * its grant would be evidence nobody is authorized to finalize, and a grant
 * without its obligation would be authority nobody is scheduled to use.
 */
async function sealAttemptInTx(
  tx: Tx,
  input: SealTransactionInput,
): Promise<SealedAttemptHandle> {
  const { attempt } = input;

  const sealRows = (await tx.execute(
    buildInsertAttemptSealSql({
      orgId: attempt.org_id,
      workspaceId: attempt.workspace_id,
      runId: attempt.run_id,
      attemptId: attempt.attempt_id,
      terminalStatus: input.terminalStatus,
      reasonCode: input.reasonCode,
      eventCount: input.eventCount,
      finalRunSeq: input.finalRunSeq,
      finalAttemptSeq: input.finalAttemptSeq,
      finalEventDigest: input.finalEventDigest,
      eventStreamDigest: input.eventStreamDigest,
      sealerId: input.sealerId,
    }),
  )) as unknown as Array<{ id: string }>;
  const seal = sealRows[0];
  if (!seal) {
    throw new RunStoreStateError(
      `attempt ${attempt.attempt_id} seal insert returned no row`,
    );
  }

  const grantRows = (await tx.execute(
    buildInsertFinalizationGrantSql({
      publicId: generateFinalizationGrantPublicId(),
      orgId: attempt.org_id,
      workspaceId: attempt.workspace_id,
      runId: attempt.run_id,
      attemptId: attempt.attempt_id,
      attemptPublicId: attempt.attempt_public_id,
      sealId: seal.id,
      eventCount: input.eventCount,
      finalEventDigest: input.finalEventDigest,
      eventStreamDigest: input.eventStreamDigest,
    }),
  )) as unknown as Array<{ id: string; public_id: string }>;
  const grant = grantRows[0];
  if (!grant) {
    throw new RunStoreStateError(
      `attempt ${attempt.attempt_id} finalization grant insert returned no row`,
    );
  }

  const obligationRows = (await tx.execute(
    buildInsertFinalizationObligationSql({
      orgId: attempt.org_id,
      workspaceId: attempt.workspace_id,
      grantId: grant.id,
      // The grant's own `afg_` public id IS the stable submission id.
      submissionId: grant.public_id,
      runId: attempt.run_id,
      attemptId: attempt.attempt_id,
      sealId: seal.id,
    }),
  )) as unknown as Array<{ id: string }>;
  const obligation = obligationRows[0];
  if (!obligation) {
    throw new RunStoreStateError(
      `attempt ${attempt.attempt_id} finalization obligation insert returned no row`,
    );
  }

  return {
    runId: attempt.run_id,
    attemptId: attempt.attempt_id,
    attemptPublicId: attempt.attempt_public_id,
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
  attempt: LockedAttemptRow,
): Promise<SealedAttemptHandle> {
  const rows = (await tx.execute(
    buildSelectFinalizationHandleSql(attempt.attempt_id),
  )) as unknown as FinalizationHandleRow[];
  const row = rows[0];
  if (!row) {
    throw new RunStoreStateError(
      `attempt ${attempt.attempt_id} is sealed but has no finalization grant or obligation`,
    );
  }
  return mapFinalizationHandleRow(row, {
    runId: attempt.run_id,
    attemptId: attempt.attempt_id,
    attemptPublicId: attempt.attempt_public_id,
  });
}

async function lockAttemptInTx(
  tx: Tx,
  attemptId: string,
): Promise<LockedAttemptRow | undefined> {
  const rows = (await tx.execute(
    buildLockAttemptForWriteSql(attemptId),
  )) as unknown as LockedAttemptRow[];
  return rows[0];
}

// ── The store ────────────────────────────────────────────────────────────────

/** Fail-loud fallback sink — see `RunStoreOptions.securityEvents`. */
const CONSOLE_SECURITY_EVENT_SINK: RunSecurityEventSink = {
  recordEventSequenceConflict(event) {
    console.error(`[run-ledger] ${EVENT_SEQUENCE_CONFLICT_EVENT}`, event);
  },
};

export function createPostgresRunStore(
  options: RunStoreOptions = {},
): RunStore {
  const securityEvents = options.securityEvents ?? CONSOLE_SECURITY_EVENT_SINK;
  return {
    async createRun(input) {
      const publicId = generateRunPublicId();
      const specDigest = runSpecV2Digest(input.spec);
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildCreateRunSql(publicId, specDigest, input),
        )) as unknown as Array<
          RunV2IdentityRow & { id: string; public_id: string }
        >;
        const row = rows[0];
        if (!row) {
          throw new RunStoreStateError("createRun insert returned no row");
        }
        // Verify what Postgres ACTUALLY stored against the parsed spec —
        // including that the internal uuids admission resolved really do
        // address the public ids the spec pinned (that is what the joins in
        // the query are for). A mismatch throws inside the transaction, so the
        // run row never survives.
        assertRunRowMatchesSpec(mapRunV2IdentityRow(row), input.spec);
        return { runId: row.id, publicId: row.public_id, specDigest };
      });
    },

    async createAttempt(input) {
      return withTenantDb(async (tx: Tx) => {
        const runRows = (await tx.execute(
          buildLockRunForAttemptSql(input.runId),
        )) as unknown as Array<{
          id: string;
          org_id: string;
          workspace_id: string;
          spec_version: number | string;
          status: string;
          attempt_count: number | string;
          max_attempts: number | string | null;
        }>;
        const run = runRows[0];
        if (!run) {
          throw new RunStoreStateError(`run ${input.runId} does not exist`);
        }
        if (Number(run.spec_version) !== 2 || run.max_attempts === null) {
          // A preserved legacy row has no pinned attempt ceiling and no trusted
          // identity, so it can never carry evidence-grade attempts.
          throw new RunStoreStateError(
            `run ${input.runId} is a preserved legacy row and cannot take attempts`,
          );
        }
        const maxAttempts = Number(run.max_attempts);
        const attemptNumber = Number(run.attempt_count) + 1;
        if (attemptNumber > maxAttempts) {
          throw new RunStoreStateError(
            `run ${input.runId} has exhausted its pinned max_attempts (${maxAttempts})`,
          );
        }

        const attemptRows = (await tx.execute(
          buildInsertAttemptSql({
            publicId: generateAttemptPublicId(),
            orgId: run.org_id,
            workspaceId: run.workspace_id,
            runId: run.id,
            attemptNumber,
            producerId: input.producerId,
            engine: input.engine,
            resumedFrom: input.resumedFrom ?? null,
          }),
        )) as unknown as Array<{
          id: string;
          public_id: string;
          attempt_number: number | string;
        }>;
        const attempt = attemptRows[0];
        if (!attempt) {
          throw new RunStoreStateError(
            `run ${input.runId} attempt insert returned no row`,
          );
        }

        const marked = (await tx.execute(
          buildMarkRunAttemptedSql(run.id, attempt.id),
        )) as unknown as Array<{ id: string }>;
        if (marked.length === 0) {
          throw new RunStoreStateError(
            `run ${input.runId} could not be marked running`,
          );
        }

        return {
          attemptId: attempt.id,
          attemptPublicId: attempt.public_id,
          runId: run.id,
          orgId: run.org_id,
          workspaceId: run.workspace_id,
          attemptNumber: Number(attempt.attempt_number),
          maxAttempts,
          engine: input.engine,
          resumedFrom: input.resumedFrom ?? null,
        };
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
        attemptPublicId: string;
      } | null = null;
      try {
        return await withTenantDb(async (tx: Tx) => {
          const attempt = assertAttemptWritable(
            input.attemptId,
            await lockAttemptInTx(tx, input.attemptId),
          );
          conflictScope = {
            orgId: attempt.org_id,
            workspaceId: attempt.workspace_id,
            runId: attempt.run_id,
            attemptPublicId: attempt.attempt_public_id,
          };
          const { state, rows } = await readAttemptStateInTx(
            tx,
            input.attemptId,
          );
          return appendPreparedBatchInTx(tx, attempt, state, rows, prepared);
        });
      } catch (err) {
        // Reported AFTER the transaction rolled back, deliberately: a sink
        // writing inside that transaction would have its audit row rolled back
        // together with the conflicting append, erasing the one record this
        // requirement exists to create.
        if (err instanceof RunEventIntegrityError && conflictScope !== null) {
          const scope: {
            orgId: string;
            workspaceId: string;
            runId: string;
            attemptPublicId: string;
          } = conflictScope;
          try {
            await securityEvents.recordEventSequenceConflict({
              type: EVENT_SEQUENCE_CONFLICT_EVENT,
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              runId: scope.runId,
              attemptId: err.attemptId,
              attemptPublicId: scope.attemptPublicId,
              attemptSeq: err.attemptSeq,
              storedDigest: err.storedDigest,
              incomingDigest: err.incomingDigest,
            });
          } catch (sinkErr) {
            // A sink that throws must not REPLACE the integrity error — the
            // caller would then see an unrelated failure and could not tell an
            // audit-transport outage from a benign append error. Log the sink
            // failure loudly, keep the diagnostic that matters, and rethrow the
            // original below.
            console.error(
              `[run-ledger] ${EVENT_SEQUENCE_CONFLICT_EVENT} sink failed`,
              sinkErr,
            );
          }
        }
        throw err;
      }
    },

    async sealAttempt(input) {
      const terminalEvent = input.terminalEvent
        ? prepareAttemptEvent(input.terminalEvent)
        : null;
      if (terminalEvent && !isTerminalEventType(terminalEvent.eventType)) {
        throw new RunStoreStateError(
          `event type ${terminalEvent.eventType} is not a terminal-stage event`,
        );
      }

      return withTenantDb(async (tx: Tx) => {
        const locked = await lockAttemptInTx(tx, input.attemptId);
        // A duplicate seal returns the SAME handle — above all the same
        // submission id — rather than minting a second grant.
        if (attemptRejectionReason(locked) === "sealed") {
          return readSealedHandleInTx(tx, locked as LockedAttemptRow);
        }
        const attempt = assertAttemptWritable(input.attemptId, locked);

        const { state, rows } = await readAttemptStateInTx(tx, input.attemptId);
        const appended = terminalEvent
          ? await appendPreparedBatchInTx(tx, attempt, state, rows, [
              terminalEvent,
            ])
          : null;

        const eventCount = appended ? appended.eventCount : state.eventCount;
        const hasEvents = eventCount > 0;
        const handle = await sealAttemptInTx(tx, {
          attempt,
          terminalStatus: input.terminalStatus,
          reasonCode: input.reasonCode ?? null,
          eventCount,
          // A zero-event attempt seals with a null final-event digest and the
          // canonical empty-stream digest; it never invents a terminal event to
          // satisfy the seal's shape.
          finalRunSeq: hasEvents
            ? (appended?.lastRunSeq ?? state.lastRunSeq)
            : null,
          finalAttemptSeq: hasEvents
            ? (appended?.lastAttemptSeq ?? state.lastAttemptSeq)
            : null,
          finalEventDigest: hasEvents
            ? (appended?.finalEventDigest ?? state.finalEventDigest)
            : null,
          eventStreamDigest: appended
            ? appended.eventStreamDigest
            : state.eventStreamDigest,
          sealerId: input.sealerId,
        });

        await tx.execute(
          buildFinishRunSql(
            attempt.run_id,
            runStatusForTerminal(input.terminalStatus),
            input.result ?? null,
            input.error ?? null,
          ),
        );

        return handle;
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

    async listRunAttempts(runId) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildListRunAttemptsSql(runId),
        )) as unknown as AttemptRow[];
        return rows.map(mapAttemptRow);
      });
    },

    async readAttemptState(attemptId) {
      return withTenantDb(async (tx: Tx) => {
        const { state } = await readAttemptStateInTx(tx, attemptId);
        return state;
      });
    },

    async readAttemptEventsSince(runId, afterRunSeq, limit) {
      return withTenantDb(async (tx: Tx) => {
        const rows = (await tx.execute(
          buildReadAttemptEventsSinceSql(runId, afterRunSeq, limit),
        )) as unknown as AttemptEventReadRow[];
        return rows.map(mapAttemptEventReadRow);
      });
    },

    async getFinalizationHandle(attemptId) {
      return withTenantDb(async (tx: Tx) => {
        const attemptRows = (await tx.execute(
          buildListAttemptIdentitySql(attemptId),
        )) as unknown as Array<{
          attempt_id: string;
          attempt_public_id: string;
          run_id: string;
        }>;
        const attempt = attemptRows[0];
        if (!attempt) return null;
        const rows = (await tx.execute(
          buildSelectFinalizationHandleSql(attemptId),
        )) as unknown as FinalizationHandleRow[];
        const row = rows[0];
        return row
          ? mapFinalizationHandleRow(row, {
              runId: attempt.run_id,
              attemptId: attempt.attempt_id,
              attemptPublicId: attempt.attempt_public_id,
            })
          : null;
      });
    },
  };
}

/**
 * Resolve one attempt's identity without taking a lock — the read-side
 * counterpart of `buildLockAttemptForWriteSql`, used by the finalization-handle
 * read where no write follows.
 */
export function buildListAttemptIdentitySql(attemptId: string): SQL {
  return sql`
    SELECT id AS attempt_id, public_id AS attempt_public_id, run_id
    FROM agent.agent_run_attempts
    WHERE id = ${attemptId}::uuid
  `;
}
