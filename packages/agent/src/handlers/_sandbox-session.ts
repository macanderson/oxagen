// Shared orchestration for the durable `agent.sandbox.*` handlers.
//
// Two concerns live here so the four thin handlers stay declarative:
//   1. Driver gating — resolve the active sandbox driver and assert it can hold
//      durable sessions (only Modal can today); fail closed otherwise.
//   2. The `sandbox_sessions` registry — short, tenant-scoped reads/writes that
//      map our opaque `sbx_…` session id to the driver's live sandbox id and the
//      last filesystem snapshot. DB work is deliberately split into small
//      `withTenantDb` calls so no transaction is held open across a multi-second
//      Modal exec/HTTP round-trip.
import pino from "pino";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  getSandbox,
  isSandboxAvailable,
  isDurableSandboxDriver,
  type DurableSandboxDriver,
  type SandboxImageKind,
  type SandboxSessionSpec,
} from "@oxagen/sandbox";
import type { SecretSelection } from "@oxagen/plugins";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.sandbox-session" },
});

export class DurableSandboxUnavailableError extends Error {
  readonly code = "durable_sandbox_unavailable";
  constructor() {
    super(
      "Durable sandbox sessions are not available. Set SANDBOX_ENABLED=true and use a " +
        "session-capable driver (Modal: SANDBOX_DRIVER=modal with MODAL_RUNNER_URL + MODAL_RUNNER_TOKEN).",
    );
    this.name = "DurableSandboxUnavailableError";
  }
}

export class SandboxSessionNotFoundError extends Error {
  readonly code = "sandbox_session_not_found";
  constructor(sessionId: string) {
    super(`Sandbox session "${sessionId}" was not found in this workspace, or it has been stopped.`);
    this.name = "SandboxSessionNotFoundError";
  }
}

export class SandboxSessionGoneError extends Error {
  readonly code = "sandbox_session_gone";
  constructor(sessionId: string) {
    super(
      `Sandbox session "${sessionId}" was reaped and has no snapshot to restore from. ` +
        "Start a new session with agent.sandbox.start.",
    );
    this.name = "SandboxSessionGoneError";
  }
}

/**
 * Resolve the active driver and narrow it to a durable-capable one, or throw.
 *
 * An optional `provider` (from a sandbox template) selects that driver instead
 * of the deployment default. A provider whose driver cannot hold durable
 * sessions (docker, vercel) or is unconfigured (modal without creds) fails fast
 * — a template that demands a non-session provider never provisions.
 */
export function requireDurableDriver(provider?: string): DurableSandboxDriver {
  if (!isSandboxAvailable()) throw new DurableSandboxUnavailableError();
  const driver = getSandbox(provider);
  if (!isDurableSandboxDriver(driver)) throw new DurableSandboxUnavailableError();
  return driver;
}

/**
 * Resolve the durable driver for an EXISTING session, keyed on the provider that
 * actually created it (the row's `driver` column) rather than the deployment
 * default — vendor neutrality for the whole session lifecycle (exec, snapshot,
 * stop, reaper reconcile). A null column falls back to the deployment default,
 * so pre-column rows still resolve.
 *
 * Throwing variant: for handlers (exec/file/log/snapshot) that cannot proceed
 * without a live driver. Fails closed with DurableSandboxUnavailableError.
 */
export function requireDurableDriverForRow(driver: string | null): DurableSandboxDriver {
  return requireDurableDriver(driver ?? undefined);
}

/**
 * Non-throwing variant of {@link requireDurableDriverForRow}: resolve the
 * session's driver, or return null when no durable driver is available for that
 * provider (unconfigured, missing creds, or non-session-capable). Lets a caller
 * that only needs a best-effort provider call — `stop_sandbox` retiring a row,
 * `list_sandboxes` reconciling status — still do its Postgres work when the
 * provider is unreachable instead of throwing. Never resolves the wrong
 * provider: an explicit `driver` column that cannot be built yields null, not a
 * silent fallback to the deployment default.
 */
export function resolveSessionDriver(driver: string | null): DurableSandboxDriver | null {
  if (!isSandboxAvailable()) return null;
  try {
    const resolved = getSandbox(driver ?? undefined);
    return isDurableSandboxDriver(resolved) ? resolved : null;
  } catch {
    // getSandbox(provider) throws for an unknown/unconfigured provider (e.g.
    // "modal" without runner creds). Treat as unavailable, not fatal.
    return null;
  }
}

/** Persisted on the registry row so a restored session reuses the same spec. */
export interface SessionMeta {
  memoryMb: number;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  network: "allow" | "deny";
  /**
   * Human-friendly name for the session, shown in the sandbox list so a person
   * can tell warm sandboxes apart. Display-only — reuse is keyed by sessionKey,
   * never this. Stored in the metadata JSON blob (no migration); absent for
   * sessions started without a name.
   */
  label?: string;
  /**
   * Workspace environment id (env_…) bound to this session at start time, if
   * any. `agent.sandbox.exec` resolves this environment's vault secrets and
   * injects them (below the caller-supplied env) into every command, so a
   * durable session carries its trusted secrets across turns without them
   * living in the sandbox filesystem. Stored in the metadata JSON blob — no
   * migration — and absent for sessions started without an environment.
   */
  environmentId?: string;
  /**
   * Sandbox-template config frozen onto the session at start time so every
   * `agent.sandbox.exec` run and any snapshot restore reproduce the exact
   * environment. All optional (absent for sessions started without a template).
   */
  imageRef?: string;
  vcpu?: number;
  diskMb?: number;
  /** Template vault secret selection (Spec §5.2) applied at exec-time injection. */
  secretSelection?: SecretSelection;
  /** Template literal_env — non-sensitive config injected at lowest precedence. */
  literalEnv?: Record<string, string>;
}

export interface SessionRow {
  id: string;
  publicId: string;
  sandboxId: string;
  snapshotId: string | null;
  image: SandboxImageKind;
  status: string;
  /**
   * Provider that created this session (the `driver` column, e.g. "modal").
   * Every lifecycle op (exec/snapshot/stop/reaper) resolves the driver from
   * THIS, not the deployment default, so a session never targets the wrong
   * provider. Null only for pre-column legacy rows → fall back to the default.
   */
  driver: string | null;
  metadata: SessionMeta;
}

const SESSION_COLUMNS = {
  id: schema.sandboxSessions.id,
  publicId: schema.sandboxSessions.publicId,
  sandboxId: schema.sandboxSessions.sandboxId,
  snapshotId: schema.sandboxSessions.snapshotId,
  image: schema.sandboxSessions.image,
  status: schema.sandboxSessions.status,
  driver: schema.sandboxSessions.driver,
  metadata: schema.sandboxSessions.metadata,
} as const;

function toRow(raw: Record<string, unknown> | undefined): SessionRow | null {
  if (!raw) return null;
  return {
    id: raw.id as string,
    publicId: raw.publicId as string,
    sandboxId: raw.sandboxId as string,
    snapshotId: (raw.snapshotId as string | null) ?? null,
    image: raw.image as SandboxImageKind,
    status: raw.status as string,
    driver: (raw.driver as string | null) ?? null,
    metadata: (raw.metadata as SessionMeta | null) ?? {
      memoryMb: 2048,
      ttlSeconds: 86_400,
      idleTimeoutSeconds: 1_200,
      network: "allow",
    },
  };
}

/** Reconstruct a driver spec from a registry row (used for restore). */
export function specFromRow(row: SessionRow, ctx: CapabilityContext): SandboxSessionSpec {
  return {
    image: row.image,
    ...(row.metadata.imageRef ? { imageRef: row.metadata.imageRef } : {}),
    memoryMb: row.metadata.memoryMb,
    ...(row.metadata.vcpu !== undefined ? { vcpu: row.metadata.vcpu } : {}),
    ...(row.metadata.diskMb !== undefined ? { diskMb: row.metadata.diskMb } : {}),
    ttlSeconds: row.metadata.ttlSeconds,
    idleTimeoutSeconds: row.metadata.idleTimeoutSeconds,
    network: row.metadata.network,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
}

/** Find a live (running|idle) session for a reuse key in this workspace. */
export async function findReusableSession(
  ctx: CapabilityContext,
  sessionKey: string,
): Promise<SessionRow | null> {
  return withTenantDb(async (tx) => {
    const [raw] = await tx
      .select(SESSION_COLUMNS)
      .from(schema.sandboxSessions)
      .where(
        and(
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
          eq(schema.sandboxSessions.sessionKey, sessionKey),
          inArray(schema.sandboxSessions.status, ["running", "idle"]),
          isNull(schema.sandboxSessions.deletedAt),
        ),
      )
      .limit(1);
    return toRow(raw);
  });
}

/**
 * Look a session up by its opaque public id, scoped to the workspace.
 *
 * By default soft-deleted rows are excluded (an already-stopped session reads as
 * "not found"). Pass `includeDeleted: true` so a caller that must be idempotent
 * over a retired session — `stop_sandbox` returning success for a second stop —
 * can still observe the terminal row.
 */
export async function getSessionByPublicId(
  ctx: CapabilityContext,
  publicId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<SessionRow | null> {
  return withTenantDb(async (tx) => {
    const conditions = [
      eq(schema.sandboxSessions.publicId, publicId),
      eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
    ];
    if (!opts.includeDeleted) {
      conditions.push(isNull(schema.sandboxSessions.deletedAt));
    }
    const [raw] = await tx
      .select(SESSION_COLUMNS)
      .from(schema.sandboxSessions)
      .where(and(...conditions))
      .limit(1);
    return toRow(raw);
  });
}

/**
 * Merge a partial patch into a session's metadata jsonb WITHOUT clobbering the
 * other keys. Uses the Postgres `||` jsonb concat operator so a concurrent
 * writer's keys survive — `rename_sandbox` sets `label` while `start`/`exec` may
 * hold the frozen session spec (memoryMb, secretSelection, …) in the same blob.
 * Tenant-scoped; bumps `updated_at` (not `$onUpdate`-managed on this table).
 */
export async function updateSessionMetadata(
  ctx: CapabilityContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({
        metadata: sql`${schema.sandboxSessions.metadata} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(schema.sandboxSessions.id, id),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
        ),
      );
  });
}

export interface InsertSessionArgs {
  sessionKey: string | null;
  driver: string;
  image: SandboxImageKind;
  sandboxId: string;
  metadata: SessionMeta;
  expiresAt: Date | null;
}

/** Insert a registry row for a freshly-created session; returns its public id. */
export async function insertSession(
  ctx: CapabilityContext,
  args: InsertSessionArgs,
): Promise<string> {
  return withTenantDb(async (tx) => {
    const [raw] = await tx
      .insert(schema.sandboxSessions)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        sessionKey: args.sessionKey,
        driver: args.driver,
        image: args.image,
        sandboxId: args.sandboxId,
        status: "running",
        lastUsedAt: new Date(),
        expiresAt: args.expiresAt,
        metadata: args.metadata,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({ publicId: schema.sandboxSessions.publicId });
    return (raw as { publicId: string }).publicId;
  });
}

/** Bump last_used_at (and keep status running) for a live session. */
export async function touchSession(ctx: CapabilityContext, id: string): Promise<void> {
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      // Clear grace_deadline_at: an active turn is holding this session, so it
      // must not be a reap candidate until it releases to 'idle' again.
      .set({ lastUsedAt: new Date(), status: "running", graceDeadlineAt: null, updatedByUserId: ctx.userId })
      .where(
        and(
          eq(schema.sandboxSessions.id, id),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
        ),
      );
  });
}

/** Point a session at a new live sandbox id after a restore. */
export async function rebindSession(
  ctx: CapabilityContext,
  id: string,
  sandboxId: string,
): Promise<void> {
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({
        sandboxId,
        status: "running",
        lastUsedAt: new Date(),
        graceDeadlineAt: null,
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(schema.sandboxSessions.id, id),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
        ),
      );
  });
}

/** Record the latest filesystem snapshot id for a session. */
export async function recordSnapshot(
  ctx: CapabilityContext,
  id: string,
  snapshotId: string,
): Promise<void> {
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({ snapshotId, updatedByUserId: ctx.userId })
      .where(
        and(
          eq(schema.sandboxSessions.id, id),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
        ),
      );
  });
}

/** Mark a session 'stopped' (soft delete) or 'gone' (reaped, unrecoverable). */
export async function markSessionStatus(
  ctx: CapabilityContext,
  id: string,
  status: "stopped" | "gone",
): Promise<void> {
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({
        status,
        deletedAt: status === "stopped" ? new Date() : null,
        deletedByUserId: status === "stopped" ? ctx.userId : null,
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(schema.sandboxSessions.id, id),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
        ),
      );
  });
}

// ── Session lifecycle: idle-release + grace configuration ───────────────────
// (spec: docs/specs/sandbox-session-lifecycle/spec.md §4)

/** Clamp an env-configured seconds value; fall back on NaN/≤0. */
function envSeconds(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Grace window (seconds) between a session going idle and the reaper being
 * allowed to flush it. Default 120s: with a 1-minute reaper cron the real-world
 * drop lands inside the 2-3 minute target. Env: SANDBOX_SESSION_GRACE_SECONDS.
 */
export function sandboxGraceSeconds(): number {
  return envSeconds("SANDBOX_SESSION_GRACE_SECONDS", 120);
}

/**
 * Backstop window (seconds) for a 'running' session whose turn crashed without
 * releasing — longer than any real turn. Env: SANDBOX_SESSION_STALE_RUNNING_SECONDS.
 */
export function sandboxStaleRunningSeconds(): number {
  return envSeconds("SANDBOX_SESSION_STALE_RUNNING_SECONDS", 1800);
}

/**
 * Release a session at turn end: mark it 'idle' and set the reap grace deadline,
 * keeping the sandbox WARM instead of tearing it down. This is the crux of
 * cross-turn persistence — the next turn's `findReusableSession` reconnects to
 * the same live sandbox (and its working tree, including uncommitted edits).
 *
 * Guarded on the current status so an error path that already stopped/reaped the
 * session is never resurrected to 'idle'. Keyed by public id (what the caller
 * holds); a no-op when the session is gone.
 */
export async function releaseSession(ctx: CapabilityContext, publicId: string): Promise<void> {
  const graceMs = sandboxGraceSeconds() * 1000;
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({
        status: "idle",
        lastUsedAt: new Date(),
        graceDeadlineAt: new Date(Date.now() + graceMs),
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(schema.sandboxSessions.publicId, publicId),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
          inArray(schema.sandboxSessions.status, ["running", "idle"]),
          isNull(schema.sandboxSessions.deletedAt),
        ),
      );
  });
}
