import type {
  AgentSandboxListInput,
  AgentSandboxListOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.list";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { isSandboxAvailable } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import { resolveSessionDriver, markSessionStatus } from "./_sandbox-session";

export type { AgentSandboxListInput, AgentSandboxListOutput };

type Sandbox = AgentSandboxListOutput["sandboxes"][number];
type Repo = NonNullable<Sandbox["repos"]>[number];

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "list_sandboxes" },
});

/**
 * Cap on live driver status checks per list request. Each is a provider
 * round-trip, so reconcile only ever touches the first N running|idle rows —
 * the rest keep their last-known DB status (self-heals on the next call).
 */
const RECONCILE_LIMIT = 25;

/**
 * Pull the human-friendly `label` out of the session's metadata JSON blob.
 * Metadata is an untyped jsonb bag (`SessionMeta`), so we defensively check the
 * shape rather than trust a cast — a non-string / missing label degrades to null.
 */
function readLabel(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object") {
    const label = (metadata as { label?: unknown }).label;
    if (typeof label === "string" && label.trim().length > 0) return label;
  }
  return null;
}

/**
 * Pull the `repos` passthrough out of the session's metadata JSON blob (written
 * by start_sandbox when a session is provisioned against one or more repos).
 * Defensive: any malformed entry is dropped; an empty/absent list yields
 * undefined so the field is omitted from the row entirely.
 */
function readRepos(metadata: unknown): Repo[] | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as { repos?: unknown }).repos;
  if (!Array.isArray(raw)) return undefined;
  const repos: Repo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const owner = (item as { owner?: unknown }).owner;
    const repo = (item as { repo?: unknown }).repo;
    const branch = (item as { branch?: unknown }).branch;
    if (typeof owner === "string" && typeof repo === "string") {
      repos.push({
        owner,
        repo,
        ...(typeof branch === "string" ? { branch } : {}),
      });
    }
  }
  return repos.length > 0 ? repos : undefined;
}

// Columns projected for the listing. `id` and `sandboxId` are driver-internal
// handles the client never sees — they are read ONLY to drive the live status
// reconcile (sessionStatus needs sandboxId; the corrective write needs id) and
// are stripped by toSandbox before the row leaves the handler.
const LIST_COLUMNS = {
  id: schema.sandboxSessions.id,
  publicId: schema.sandboxSessions.publicId,
  sandboxId: schema.sandboxSessions.sandboxId,
  sessionKey: schema.sandboxSessions.sessionKey,
  // Projected for the human-friendly label + repos passthrough stored on metadata.
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

type ListRow = {
  id: string;
  publicId: string;
  sandboxId: string;
  sessionKey: string | null;
  metadata: unknown;
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
};

/**
 * List the durable sandbox sessions in the caller's workspace.
 *
 * Reads the `sandbox_sessions` registry (soft-deleted rows excluded; optional
 * `status` narrows the lifecycle state), then LIVE-RECONCILES the running|idle
 * rows against each session's own driver so the list never reports a session as
 * running/idle that the provider has already terminated. A dead session is
 * corrected to `stopped` (same terminal semantics as an explicit stop) and the
 * fix persisted. Reconcile is bounded (≤25 driver calls, per-row errors
 * tolerated, skipped entirely when no sandbox driver is available) so the
 * listing degrades to the raw DB read rather than failing. Ordered by
 * last_used_at DESC (nulls last), then created_at DESC.
 */
export async function agentSandboxListHandler(
  input: AgentSandboxListInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxListOutput> {
  const rows = (await withTenantDb(async (tx) => {
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
  })) as ListRow[];

  const correctedToStopped = await reconcileLiveStatus(ctx, rows);

  const sandboxes = rows.map((row) =>
    toSandbox(row, correctedToStopped.has(row.publicId)),
  );

  // Re-apply the status / activeOnly filters AFTER reconcile so a row the
  // provider says is dead never leaks past a running/idle-shaped filter with a
  // stale status. For the default (no status, activeOnly false) this is a no-op.
  const filtered = sandboxes.filter((s) => {
    if (input.status && s.status !== input.status) return false;
    if (input.activeOnly && s.status !== "running" && s.status !== "idle") {
      return false;
    }
    return true;
  });

  return { sandboxes: filtered };
}

/**
 * Live-reconcile the running|idle rows against their session's driver. Returns
 * the set of public ids the provider reports as gone (already persisted as
 * stopped). Bounded, fault-tolerant, and a no-op when no driver is available.
 */
async function reconcileLiveStatus(
  ctx: CapabilityContext,
  rows: ListRow[],
): Promise<Set<string>> {
  const corrected = new Set<string>();
  // If no durable driver is configured at all, there is nothing to reconcile
  // against — return the raw DB view rather than guessing.
  if (!isSandboxAvailable()) return corrected;

  const candidates = rows
    .filter((r) => r.status === "running" || r.status === "idle")
    .slice(0, RECONCILE_LIMIT);

  await Promise.allSettled(
    candidates.map(async (r) => {
      // Resolve the session's OWN driver (vendor-neutral) — never the deployment
      // default. A null result means that provider is unavailable; skip the row.
      const driver = resolveSessionDriver(r.driver);
      if (!driver) return;
      let live: "running" | "gone";
      try {
        live = await driver.sessionStatus(r.sandboxId);
      } catch (err) {
        // A transient provider hiccup must not fail the whole listing; leave the
        // row's DB status untouched and let the next call retry.
        logger.debug(
          { err, sessionId: r.publicId },
          "list_sandboxes: sessionStatus failed; skipping reconcile for row",
        );
        return;
      }
      if (live === "gone") {
        // Persist the correction with the SAME terminal semantics as stop.
        await markSessionStatus(ctx, r.id, "stopped");
        corrected.add(r.publicId);
      }
    }),
  );

  return corrected;
}

/**
 * Map a registry row to the contract's output shape (dates → ISO strings). When
 * `correctedToStopped`, the provider reported the session gone during reconcile,
 * so the surfaced status is forced to `stopped` regardless of the stale DB value.
 */
function toSandbox(row: ListRow, correctedToStopped: boolean): Sandbox {
  const repos = readRepos(row.metadata);
  return {
    sessionId: row.publicId,
    sessionKey: row.sessionKey,
    label: readLabel(row.metadata),
    // The DB CHECK constraint restricts these columns to the enum members, so
    // the narrowing cast is safe — no runtime value can fall outside the union.
    image: row.image as Sandbox["image"],
    status: correctedToStopped ? "stopped" : (row.status as Sandbox["status"]),
    driver: row.driver,
    ...(repos ? { repos } : {}),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // Lifecycle & work-recovery (spec: sandbox-session-lifecycle).
    recoveryStatus: row.recoveryStatus,
    recoveryBranch: row.recoveryBranch,
    recoveryCommit: row.recoveryCommit,
    graceDeadlineAt: row.graceDeadlineAt
      ? row.graceDeadlineAt.toISOString()
      : null,
    dirty: row.dirty,
    flushedAt: row.flushedAt ? row.flushedAt.toISOString() : null,
    recoveredAt: row.recoveredAt ? row.recoveredAt.toISOString() : null,
  };
}
