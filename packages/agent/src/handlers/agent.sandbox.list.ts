import type {
  AgentSandboxListInput,
  AgentSandboxListOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.list";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";

export type { AgentSandboxListInput, AgentSandboxListOutput };

type Sandbox = AgentSandboxListOutput["sandboxes"][number];

// Columns projected for the listing. Deliberately excludes the driver-internal
// sandboxId / snapshotId — the client never needs the live driver handle, only
// the opaque public id (sbx_…).
const LIST_COLUMNS = {
  publicId: schema.sandboxSessions.publicId,
  sessionKey: schema.sandboxSessions.sessionKey,
  // Projected for the human-friendly label stored under metadata.label.
  metadata: schema.sandboxSessions.metadata,
  image: schema.sandboxSessions.image,
  status: schema.sandboxSessions.status,
  driver: schema.sandboxSessions.driver,
  lastUsedAt: schema.sandboxSessions.lastUsedAt,
  expiresAt: schema.sandboxSessions.expiresAt,
  createdAt: schema.sandboxSessions.createdAt,
  // Lifecycle & work-recovery fields (spec: sandbox-session-lifecycle) — so the
  // listing surfaces reap/recovery state without a per-session round-trip.
  recoveryStatus: schema.sandboxSessions.recoveryStatus,
  recoveryBranch: schema.sandboxSessions.recoveryBranch,
  recoveryCommit: schema.sandboxSessions.recoveryCommit,
  graceDeadlineAt: schema.sandboxSessions.graceDeadlineAt,
  dirty: schema.sandboxSessions.dirty,
  flushedAt: schema.sandboxSessions.flushedAt,
  recoveredAt: schema.sandboxSessions.recoveredAt,
} as const;

/**
 * List the durable sandbox sessions in the caller's workspace.
 *
 * Pure Postgres read against the `sandbox_sessions` registry — unlike the other
 * `agent.sandbox.*` handlers this never resolves a live driver, so it works
 * whether or not a durable driver is configured. Soft-deleted rows are
 * excluded; an optional `status` narrows the lifecycle state. Ordered by
 * last_used_at DESC (nulls last), then created_at DESC, so the most recently
 * active sessions surface first.
 */
export async function agentSandboxListHandler(
  input: AgentSandboxListInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxListOutput> {
  const rows = await withTenantDb(async (tx) => {
    const conditions = [
      eq(schema.sandboxSessions.workspaceId, ctx.workspaceId),
      isNull(schema.sandboxSessions.deletedAt),
    ];
    if (input.status) {
      conditions.push(eq(schema.sandboxSessions.status, input.status));
    }
    return tx
      .select(LIST_COLUMNS)
      .from(schema.sandboxSessions)
      .where(and(...conditions))
      .orderBy(
        sql`${schema.sandboxSessions.lastUsedAt} DESC NULLS LAST`,
        desc(schema.sandboxSessions.createdAt),
      )
      .limit(input.limit);
  });

  return { sandboxes: rows.map(toSandbox) };
}

/** Map a registry row to the contract's output shape (dates → ISO strings). */
function toSandbox(row: {
  publicId: string;
  sessionKey: string | null;
  image: string;
  status: string;
  driver: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  recoveryStatus: string;
  recoveryBranch: string | null;
  recoveryCommit: string | null;
  graceDeadlineAt: Date | null;
  dirty: boolean | null;
  flushedAt: Date | null;
  recoveredAt: Date | null;
}): Sandbox {
  return {
    sessionId: row.publicId,
    sessionKey: row.sessionKey,
    // The DB CHECK constraint restricts these columns to the enum members, so
    // the narrowing cast is safe — no runtime value can fall outside the union.
    image: row.image as Sandbox["image"],
    status: row.status as Sandbox["status"],
    driver: row.driver,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // Lifecycle & work-recovery (spec: sandbox-session-lifecycle).
    recoveryStatus: row.recoveryStatus,
    recoveryBranch: row.recoveryBranch,
    recoveryCommit: row.recoveryCommit,
    graceDeadlineAt: row.graceDeadlineAt ? row.graceDeadlineAt.toISOString() : null,
    dirty: row.dirty,
    flushedAt: row.flushedAt ? row.flushedAt.toISOString() : null,
    recoveredAt: row.recoveredAt ? row.recoveredAt.toISOString() : null,
  };
}
