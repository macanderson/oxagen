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
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  getSandbox,
  isSandboxAvailable,
  isDurableSandboxDriver,
  type DurableSandboxDriver,
  type SandboxImageKind,
  type SandboxSessionSpec,
} from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";

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

/** Resolve the active driver and narrow it to a durable-capable one, or throw. */
export function requireDurableDriver(): DurableSandboxDriver {
  if (!isSandboxAvailable()) throw new DurableSandboxUnavailableError();
  const driver = getSandbox();
  if (!isDurableSandboxDriver(driver)) throw new DurableSandboxUnavailableError();
  return driver;
}

/** Persisted on the registry row so a restored session reuses the same spec. */
export interface SessionMeta {
  memoryMb: number;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  network: "allow" | "deny";
}

export interface SessionRow {
  id: string;
  publicId: string;
  sandboxId: string;
  snapshotId: string | null;
  image: SandboxImageKind;
  status: string;
  metadata: SessionMeta;
}

const SESSION_COLUMNS = {
  id: schema.sandboxSessions.id,
  publicId: schema.sandboxSessions.publicId,
  sandboxId: schema.sandboxSessions.sandboxId,
  snapshotId: schema.sandboxSessions.snapshotId,
  image: schema.sandboxSessions.image,
  status: schema.sandboxSessions.status,
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
    memoryMb: row.metadata.memoryMb,
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

/** Look a session up by its opaque public id, scoped to the workspace. */
export async function getSessionByPublicId(
  ctx: CapabilityContext,
  publicId: string,
): Promise<SessionRow | null> {
  return withTenantDb(async (tx) => {
    const [raw] = await tx
      .select(SESSION_COLUMNS)
      .from(schema.sandboxSessions)
      .where(
        and(
          eq(schema.sandboxSessions.publicId, publicId),
          eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
          isNull(schema.sandboxSessions.deletedAt),
        ),
      )
      .limit(1);
    return toRow(raw);
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
      .set({ lastUsedAt: new Date(), status: "running", updatedByUserId: ctx.userId })
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
