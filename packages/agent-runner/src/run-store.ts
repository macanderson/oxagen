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

/** A row is failed (not requeued/reclaimed) once claimed this many times. */
export const MAX_RUN_ATTEMPTS = 3;

/** Lease window per claim — long enough for a slow multi-step agent turn. */
export const RUN_LEASE_SECONDS = 600;

/** Default page size for readEventsSince when the caller doesn't cap it. */
export const DEFAULT_READ_EVENTS_LIMIT = 500;

/** A resolved IAM principal, threaded through without being re-minted. */
export interface RunPrincipal {
  id: string;
  kind: "human" | "agent" | "service";
  orgId: string;
  workspaceId: string | null;
}

export interface EnqueueRunInput {
  orgId: string;
  workspaceId: string;
  surface: PlatformSurface;
  spec: unknown;
  /**
   * The AGENT/HUMAN principal pair for a deployed-agent run
   * (docs/specs/agent-rbac/spec.md §3.1/§3.4). Both or neither — a bare
   * conversational turn omits both. NEVER minted here: the agent's single
   * persistent identity principal (agent.agents.principalId) and the
   * invoking human's already-resolved principal must be supplied by the
   * caller that enqueues the run.
   */
  agentPrincipal?: RunPrincipal;
  humanPrincipal?: RunPrincipal;
}

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
  /**
   * The run's persistent AGENT principal, present when this run was
   * dispatched as a deployed agent run. When set together with
   * `humanPrincipal`, callers (e.g. @oxagen/agent's turn-driver) thread
   * `principalKind: "agent"` plus both principals into the CapabilityContext
   * they build for this turn — never minted here, always supplied by
   * whoever enqueued the run.
   */
  agentPrincipal?: RunPrincipal | null;
  /**
   * The invoking HUMAN principal this agent run acts on behalf of — the
   * delegation ceiling for effective-permission resolution. Present
   * whenever `agentPrincipal` is.
   */
  humanPrincipal?: RunPrincipal | null;
}

export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
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
  claimNextRun(workerId: string): Promise<ClaimedRun | null>;
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
  agent_principal_id?: string | null;
  agent_principal_org_id?: string | null;
  agent_principal_workspace_id?: string | null;
  human_principal_id?: string | null;
  human_principal_org_id?: string | null;
  human_principal_workspace_id?: string | null;
};

/** Map a claimed agent_runs row (snake_case, driver-typed) to ClaimedRun. */
export function mapClaimedRunRow(row: ClaimedRunRow): ClaimedRun {
  const agentPrincipal =
    row.agent_principal_id && row.agent_principal_org_id
      ? {
          id: row.agent_principal_id,
          kind: "agent" as const,
          orgId: row.agent_principal_org_id,
          workspaceId: row.agent_principal_workspace_id ?? null,
        }
      : null;
  const humanPrincipal =
    row.human_principal_id && row.human_principal_org_id
      ? {
          id: row.human_principal_id,
          kind: "human" as const,
          orgId: row.human_principal_org_id,
          workspaceId: row.human_principal_workspace_id ?? null,
        }
      : null;
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
    ...(agentPrincipal ? { agentPrincipal } : {}),
    ...(humanPrincipal ? { humanPrincipal } : {}),
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
    INSERT INTO agent.agent_runs (
      public_id, org_id, workspace_id, surface, status, spec,
      agent_principal_id, agent_principal_org_id, agent_principal_workspace_id,
      human_principal_id, human_principal_org_id, human_principal_workspace_id
    )
    VALUES (
      ${publicId},
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.surface},
      'pending',
      ${JSON.stringify(input.spec)}::jsonb,
      ${input.agentPrincipal?.id ?? null}::uuid,
      ${input.agentPrincipal?.orgId ?? null}::uuid,
      ${input.agentPrincipal?.workspaceId ?? null}::uuid,
      ${input.humanPrincipal?.id ?? null}::uuid,
      ${input.humanPrincipal?.orgId ?? null}::uuid,
      ${input.humanPrincipal?.workspaceId ?? null}::uuid
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
    RETURNING id, public_id, org_id, workspace_id, surface, spec, attempts, checkpoint, checkpoint_seq,
      agent_principal_id, agent_principal_org_id, agent_principal_workspace_id,
      human_principal_id, human_principal_org_id, human_principal_workspace_id
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

// ── The store ────────────────────────────────────────────────────────────────

export function createPostgresRunStore(): RunStore {
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

    async claimNextRun(workerId) {
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
  };
}
