/**
 * Postgres file-lock lease — the transactional lock authority (ADR-021 §5).
 *
 * File locks are mutual-exclusion state, so Postgres is the source of truth,
 * NOT Neo4j: eventual graph projection cannot provide mutual exclusion. This
 * extends the Inngest claim/lease mechanism
 * (`packages/inngest-functions/src/lease.ts`, Fanout Phase 2) to file-path
 * granularity rather than inventing a second lock system.
 *
 * Correctness properties:
 *   - **Atomic all-or-nothing multi-key acquire.** A single tenant transaction
 *     advisory-locks every requested resource (sorted, so two concurrent
 *     multi-key acquires can't deadlock on lock-ordering), detects live foreign
 *     holders in a read-only first pass, and only if NONE conflict does it bump
 *     fences + upsert every lock. A conflict on any key acquires nothing.
 *   - **TTL expiry.** An expired-but-unreleased row is free: the acquire path
 *     takes it over; `sweepExpiredFileLeases` reaps it for hygiene.
 *   - **Fencing tokens.** `file_lock_fences` is a durable monotonic counter per
 *     resource, bumped only on a successful acquire, so a takeover after expiry
 *     always issues a strictly higher token than any prior holder held —
 *     `verifyFileLease` rejects a stale holder's late write at write time.
 *
 * Raw `db()` is banned; every query runs through `withTenantDb` inside
 * `runInTenantScope` so RLS (`tenant_isolation` on both tables) is enforced.
 */
import { randomUUID } from "node:crypto";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";

/** Default lease window (5 min). */
export const DEFAULT_FILE_LOCK_TTL_MS = 300_000;

export interface AcquiredLease {
  resourceKey: string;
  /** The `agent.file_locks.id` — pass to renew/release. */
  lockId: string;
  /** Monotonic per resource; carry to the write and check with verifyFileLease. */
  fencingToken: number;
  /** Epoch-ms the lease expires. */
  expiresAt: number;
}

export interface LeaseConflict {
  resourceKey: string;
  /** The live holder blocking this key. */
  holder: string;
  /** Epoch-ms the blocking lease expires. */
  expiresAt: number;
}

export interface AcquireFileLeaseResult {
  /** Populated only when EVERY requested key was acquired (all-or-nothing). */
  acquired: AcquiredLease[];
  /** The live foreign holders when nothing was acquired. */
  conflicts: LeaseConflict[];
}

export interface AcquireFileLeaseArgs {
  orgId: string;
  workspaceId: string;
  /** Resource keys to lock atomically (deduped + sorted internally). */
  resourceKeys: string[];
  /** Holder identity — same holder renews, a different holder conflicts. */
  holder: string;
  /** Correlates this lock for batch release-by-execution. */
  executionId: string;
  action?: "read" | "write";
  /** Lease length in ms (default {@link DEFAULT_FILE_LOCK_TTL_MS}). */
  ttlMs?: number;
}

type FileLockRow = {
  id: string;
  resource_key: string;
  holder: string;
  execution_id: string;
  action: string;
  fencing_token: number;
  created_at: string;
  lease_expires_at: string;
};

function rowsOf<T>(result: unknown): T[] {
  return result as unknown as T[];
}

function epochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Atomically acquire (or renew, for the same holder) an exclusive lease on
 * every key in `resourceKeys`, or acquire NOTHING and report the conflicts.
 */
export async function acquireFileLease(
  args: AcquireFileLeaseArgs,
): Promise<AcquireFileLeaseResult> {
  const keys = [...new Set(args.resourceKeys)].sort();
  if (keys.length === 0) return { acquired: [], conflicts: [] };
  const ttlMs = args.ttlMs ?? DEFAULT_FILE_LOCK_TTL_MS;
  const action = args.action ?? "write";
  const ttlSeconds = ttlMs / 1000;

  const result = await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        // ── Pass 1 (read-only): serialize each resource for this tx, detect live
        // foreign holders. The advisory lock also closes the not-yet-existing-row
        // race that the partial unique index alone would only surface as a
        // violation. Locks release at tx end.
        const conflicts: LeaseConflict[] = [];
        for (const key of keys) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${args.workspaceId}:${key}`}, 0))`,
          );
          const rows = rowsOf<{ holder: string; lease_expires_at: string }>(
            await tx.execute(sql`
            SELECT holder, lease_expires_at
            FROM agent.file_locks
            WHERE workspace_id = ${args.workspaceId}::uuid
              AND resource_key = ${key}
              AND released_at IS NULL
              AND lease_expires_at > now()
              AND holder <> ${args.holder}
            LIMIT 1
          `),
          );
          if (rows[0]) {
            conflicts.push({
              resourceKey: key,
              holder: rows[0].holder,
              expiresAt: epochMs(rows[0].lease_expires_at),
            });
          }
        }
        // All-or-nothing: any conflict acquires nothing. Pass 1 wrote nothing, so
        // returning here commits a no-op — no fence bumped, no partial lock left.
        if (conflicts.length > 0) return { acquired: [], conflicts };

        // ── Pass 2: bump the durable fence + upsert each live lock. The upsert's
        // conflict target IS the partial unique index; pass 1 proved any existing
        // live row is expired or same-holder, so DO UPDATE safely takes it over.
        const acquired: AcquiredLease[] = [];
        for (const key of keys) {
          const fenceRows = rowsOf<{ current_token: number }>(
            await tx.execute(sql`
            INSERT INTO agent.file_lock_fences (org_id, workspace_id, resource_key, current_token, created_at, updated_at)
            VALUES (${args.orgId}::uuid, ${args.workspaceId}::uuid, ${key}, 1, now(), now())
            ON CONFLICT (workspace_id, resource_key)
            DO UPDATE SET current_token = agent.file_lock_fences.current_token + 1, updated_at = now()
            RETURNING current_token
          `),
          );
          const fenceRow = fenceRows[0];
          if (!fenceRow)
            throw new Error(`file-lock: fence bump returned no row for ${key}`);
          const token = Number(fenceRow.current_token);

          // Raw SQL bypasses the Drizzle app-layer public_id default, so mint one
          // here (never updated on takeover — the existing row keeps its own).
          const publicId = `flk_${randomUUID().replace(/-/g, "")}`;
          const lockRows = rowsOf<{ id: string; lease_expires_at: string }>(
            await tx.execute(sql`
            INSERT INTO agent.file_locks
              (public_id, org_id, workspace_id, resource_key, holder, execution_id, fencing_token, action, lease_expires_at)
            VALUES
              (${publicId}, ${args.orgId}::uuid, ${args.workspaceId}::uuid, ${key}, ${args.holder}, ${args.executionId}, ${token}, ${action}, now() + make_interval(secs => ${ttlSeconds}))
            ON CONFLICT (workspace_id, resource_key) WHERE released_at IS NULL
            DO UPDATE SET
              holder = EXCLUDED.holder,
              execution_id = EXCLUDED.execution_id,
              fencing_token = EXCLUDED.fencing_token,
              action = EXCLUDED.action,
              lease_expires_at = EXCLUDED.lease_expires_at,
              updated_at = now()
            RETURNING id, lease_expires_at
          `),
          );
          const lockRow = lockRows[0];
          if (!lockRow)
            throw new Error(
              `file-lock: lock upsert returned no row for ${key}`,
            );
          acquired.push({
            resourceKey: key,
            lockId: lockRow.id,
            fencingToken: token,
            expiresAt: epochMs(lockRow.lease_expires_at),
          });
        }
        return { acquired, conflicts: [] };
      }),
  );

  return result;
}

/** Extend the caller's lease. Guarded on holder + still-live so a reclaimed lock can't be resurrected. */
export async function renewFileLease(args: {
  orgId: string;
  workspaceId: string;
  lockId: string;
  holder: string;
  ttlMs?: number;
}): Promise<{ renewed: boolean; expiresAt: number | null }> {
  const ttlSeconds = (args.ttlMs ?? DEFAULT_FILE_LOCK_TTL_MS) / 1000;
  return runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = rowsOf<{ lease_expires_at: string }>(
          await tx.execute(sql`
          UPDATE agent.file_locks
          SET lease_expires_at = now() + make_interval(secs => ${ttlSeconds}), updated_at = now()
          WHERE id = ${args.lockId}::uuid
            AND holder = ${args.holder}
            AND released_at IS NULL
            AND lease_expires_at > now()
          RETURNING lease_expires_at
        `),
        );
        return rows[0]
          ? { renewed: true, expiresAt: epochMs(rows[0].lease_expires_at) }
          : { renewed: false, expiresAt: null };
      }),
  );
}

/**
 * Release a single lease. When `holder` is given, only that holder may release
 * it (the per-write path invariant); omit it for the admin/force path that
 * clears a lock a crashed agent left behind. Idempotent → `released: false` for
 * an already-released/nonexistent lock, never an error.
 */
export async function releaseFileLease(args: {
  orgId: string;
  workspaceId: string;
  lockId: string;
  holder?: string;
}): Promise<{ released: boolean }> {
  const released = await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = rowsOf<{
          resource_key: string;
          holder: string;
          execution_id: string;
          action: string;
        }>(
          args.holder
            ? await tx.execute(sql`
              UPDATE agent.file_locks SET released_at = now(), updated_at = now()
              WHERE id = ${args.lockId}::uuid AND released_at IS NULL AND holder = ${args.holder}
              RETURNING resource_key, holder, execution_id, action
            `)
            : await tx.execute(sql`
              UPDATE agent.file_locks SET released_at = now(), updated_at = now()
              WHERE id = ${args.lockId}::uuid AND released_at IS NULL
              RETURNING resource_key, holder, execution_id, action
            `),
        );
        return rows[0] ?? null;
      }),
  );
  return { released: released !== null };
}

/**
 * Batch-release every lock an execution/turn holds — the turn-end backstop so a
 * crashed turn never leaks a lock past its own lifetime.
 */
export async function releaseFileLeasesByExecution(args: {
  orgId: string;
  workspaceId: string;
  executionId: string;
}): Promise<{ released: number }> {
  const rows = await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) =>
        rowsOf<{ resource_key: string; holder: string; action: string }>(
          await tx.execute(sql`
          UPDATE agent.file_locks SET released_at = now(), updated_at = now()
          WHERE execution_id = ${args.executionId} AND released_at IS NULL
          RETURNING resource_key, holder, action
        `),
        ),
      ),
  );
  return { released: rows.length };
}

/**
 * Write-time fencing check: `true` iff a LIVE lock on `resourceKey` still holds
 * exactly `fencingToken`. A takeover after expiry raises the token, so a stale
 * holder's late write returns `false` and must be rejected.
 */
export async function verifyFileLease(args: {
  orgId: string;
  workspaceId: string;
  resourceKey: string;
  fencingToken: number;
}): Promise<boolean> {
  return runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = rowsOf<{ ok: boolean }>(
          await tx.execute(sql`
          SELECT true AS ok
          FROM agent.file_locks
          WHERE workspace_id = ${args.workspaceId}::uuid
            AND resource_key = ${args.resourceKey}
            AND released_at IS NULL
            AND lease_expires_at > now()
            AND fencing_token = ${args.fencingToken}
          LIMIT 1
        `),
        );
        return rows.length > 0;
      }),
  );
}

/** Soft-release every expired-but-unreleased lock in the tenant. Housekeeping. */
export async function sweepExpiredFileLeases(args: {
  orgId: string;
  workspaceId: string;
}): Promise<{ swept: number }> {
  const rows = await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`
          UPDATE agent.file_locks SET released_at = now(), updated_at = now()
          WHERE released_at IS NULL AND lease_expires_at <= now()
          RETURNING id
        `),
        ),
      ),
  );
  return { swept: rows.length };
}

export interface FileLeaseRecord {
  lockId: string;
  resourceKey: string;
  holder: string;
  executionId: string;
  action: string;
  fencingToken: number;
  /** Epoch-ms the lock was created/last taken over. */
  acquiredAt: number;
  /** Epoch-ms the lease expires. */
  expiresAt: number;
}

/** List every currently-live lock in the tenant, optionally filtered to one resource. */
export async function listFileLeases(args: {
  orgId: string;
  workspaceId: string;
  resourceKey?: string;
}): Promise<{ leases: FileLeaseRecord[] }> {
  const leases = await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = rowsOf<FileLockRow>(
          await tx.execute(sql`
          SELECT id, resource_key, holder, execution_id, action, fencing_token, created_at, lease_expires_at
          FROM agent.file_locks
          WHERE workspace_id = ${args.workspaceId}::uuid
            AND released_at IS NULL
            AND lease_expires_at > now()
            AND (${args.resourceKey ?? null}::text IS NULL OR resource_key = ${args.resourceKey ?? null})
          ORDER BY created_at DESC
        `),
        );
        return rows.map((r) => ({
          lockId: r.id,
          resourceKey: r.resource_key,
          holder: r.holder,
          executionId: r.execution_id,
          action: r.action,
          fencingToken: Number(r.fencing_token),
          acquiredAt: epochMs(r.created_at),
          expiresAt: epochMs(r.lease_expires_at),
        }));
      }),
  );
  return { leases };
}
