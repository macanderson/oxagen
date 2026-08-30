import { createFunction } from "../create-function";
import { withSystemDb, schema } from "@oxagen/database";
import { sql, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertEvents, type EventRow } from "@oxagen/telemetry";
import {
  recoverSandboxSession,
  agentSandboxStopHandler,
  sandboxStaleRunningSeconds,
  type RecoveryOutcome,
} from "@oxagen/agent";
import { logger } from "../logger";

/**
 * Sandbox session reaper (spec: docs/specs/sandbox-session-lifecycle §4).
 *
 * Every minute it drops warm coding-session sandboxes that have gone idle, so a
 * session's sandbox lives only ~2-3 minutes past its last turn (vs Modal's 20-min
 * idle backstop) — the cost lever for keeping sandboxes persistent across turns.
 *
 * The HARD INVARIANT (§3): a sandbox with uncommitted work is NEVER terminated
 * before that work is captured to a recovery branch. Each candidate runs
 * recover-then-flush:
 *   - clean / no-repo / recovered / gone → terminate the sandbox, mark flushed.
 *   - failed (dirty work could not be pushed) → RETAIN the sandbox untouched and
 *     retry next tick (5-min backoff); the inspector shows "manual recovery needed".
 *
 * System-wide sweep (withSystemDb — a cron has no tenant); per-candidate work runs
 * inside the session's tenant scope. Concurrency 1 is what actually stops two
 * ticks racing the same session: the SELECT's FOR UPDATE SKIP LOCKED only holds
 * its row locks until that step's transaction commits, which is well before any
 * reaping happens. reapOne() re-checks candidacy under a fresh read instead.
 */

/** Per-tick candidate budget — each candidate does a Modal round-trip, so keep small. */
const REAP_BATCH_LIMIT = 25;

/** Backoff (minutes) before retrying a retained ('failed') recovery. */
const FAILED_RETRY_BACKOFF_MINUTES = 5;

type CandidateRow = {
  id: string;
  public_id: string;
  org_id: string;
  workspace_id: string;
  status: string;
};

/** A system-cron CapabilityContext scoped to one session's tenant. */
function reaperContext(c: CandidateRow) {
  return {
    orgId: c.org_id,
    workspaceId: c.workspace_id,
    userId: null,
    apiKeyId: null,
    requestId: `sandbox-reaper:${c.public_id}`,
    surface: "runner" as const,
    messageId: c.public_id,
  };
}

function reapEventRow(
  c: CandidateRow,
  payload: Record<string, unknown>,
): EventRow {
  return {
    event_id: crypto.randomUUID(),
    org_id: c.org_id,
    workspace_id: c.workspace_id,
    event_type: "agent.sandbox.reaped",
    source_system: "inngest:agent.sandbox-reaper",
    stream_offset: null,
    payload: JSON.stringify({ sessionId: c.public_id, ...payload }),
    emitted_at: new Date().toISOString(),
  };
}

export const [agentSandboxReaper] = createFunction(
  { id: "agent.sandbox-reaper", retries: 3, concurrency: { limit: 1 } },
  { cron: "* * * * *" },
  async ({ step }) => {
    const staleSecs = sandboxStaleRunningSeconds();

    // ── 1. Select candidates: idle-past-grace + stale-running backstop ───────
    const candidates = await step.run("select-candidates", () =>
      withSystemDb(async (tx) => {
        const rows = (await tx.execute<CandidateRow>(sql`
          SELECT id, public_id, org_id, workspace_id, status
          FROM agent.sandbox_sessions
          WHERE flushed_at IS NULL
            AND deleted_at IS NULL
            AND status IN ('idle', 'running')
            AND (
              (status = 'idle' AND grace_deadline_at IS NOT NULL AND grace_deadline_at < now())
              OR (status = 'running' AND last_used_at IS NOT NULL
                  AND last_used_at < now() - make_interval(secs => ${staleSecs}))
            )
            -- Retained failures wait a backoff before retry so a permanently
            -- unrecoverable sandbox (e.g. no remote) doesn't tight-loop.
            AND (recovery_status <> 'failed'
                 OR updated_at < now() - make_interval(mins => ${FAILED_RETRY_BACKOFF_MINUTES}))
          ORDER BY grace_deadline_at NULLS LAST
          LIMIT ${REAP_BATCH_LIMIT}
          FOR UPDATE SKIP LOCKED
        `)) as unknown as CandidateRow[];
        return rows;
      }),
    );

    if (candidates.length === 0) {
      return {
        candidates: 0,
        flushed: 0,
        recovered: 0,
        retained: 0,
        skipped: 0,
      };
    }

    // ── 2. Per-candidate recover-then-flush ─────────────────────────────────
    const results: { action: string; kind?: string }[] = [];
    for (const c of candidates) {
      const outcome = await step.run(`reap-${c.public_id}`, async () =>
        reapOne(c),
      );
      results.push(outcome);
    }

    // ── 3. Telemetry (fail-soft, like lease-sweep) ──────────────────────────
    await step.run("emit-reap-telemetry", async () => {
      const rows = candidates.map((c, i) =>
        reapEventRow(c, { action: results[i]?.action, kind: results[i]?.kind }),
      );
      try {
        await insertEvents(rows);
      } catch (err) {
        logger.warn(
          { err },
          "insertEvents failed — sandbox reap telemetry loss",
        );
      }
    });

    const summary = {
      candidates: candidates.length,
      flushed: results.filter((r) => r.action === "flushed").length,
      recovered: results.filter((r) => r.kind === "recovered").length,
      retained: results.filter((r) => r.action === "retained").length,
      skipped: results.filter((r) => r.action === "skipped").length,
    };
    logger.info(summary, "agent.sandbox-reaper: sweep complete");
    return summary;
  },
);

/**
 * Reap a single session. Re-checks candidacy under a fresh read (race guard for a
 * turn that resumed after selection), then recover-then-flush per the invariant.
 */
async function reapOne(
  c: CandidateRow,
): Promise<{ action: string; kind?: string }> {
  const staleSecs = sandboxStaleRunningSeconds();

  // Race guard: a new turn may have touched the session after selection.
  const stillCandidate = await withSystemDb(async (tx) => {
    const [row] = (await tx.execute<{
      status: string;
      grace_past: boolean;
      stale: boolean;
    }>(sql`
      SELECT status,
             (grace_deadline_at IS NOT NULL AND grace_deadline_at < now()) AS grace_past,
             (last_used_at IS NOT NULL AND last_used_at < now() - make_interval(secs => ${staleSecs})) AS stale
      FROM agent.sandbox_sessions
      WHERE id = ${c.id}::uuid AND flushed_at IS NULL AND deleted_at IS NULL
    `)) as unknown as { status: string; grace_past: boolean; stale: boolean }[];
    if (!row) return false;
    if (row.status === "idle") return Boolean(row.grace_past);
    if (row.status === "running") return Boolean(row.stale);
    return false;
  });
  if (!stillCandidate) return { action: "skipped" };

  // Mark recovering so the inspector reflects in-flight work.
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({ recoveryStatus: "recovering", updatedAt: new Date() })
      .where(eq(schema.sandboxSessions.id, c.id));
  });

  const ctx = reaperContext(c);
  let outcome: RecoveryOutcome;
  try {
    outcome = await runInTenantScope(
      { orgId: c.org_id, workspaceId: c.workspace_id },
      () => recoverSandboxSession(ctx, { sessionId: c.public_id }),
    );
  } catch (err) {
    outcome = {
      kind: "failed",
      dirty: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // RETAIN: dirty work could not be saved — never flush; retry next tick.
  if (outcome.kind === "failed") {
    await withSystemDb(async (tx) => {
      await tx
        .update(schema.sandboxSessions)
        .set({
          recoveryStatus: "failed",
          recoveryError: outcome.error ?? null,
          dirty: outcome.dirty ?? true,
          dirtyCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.sandboxSessions.id, c.id));
    });
    logger.warn(
      { sessionId: c.public_id, error: outcome.error },
      "agent.sandbox-reaper: recovery failed — sandbox RETAINED",
    );
    return { action: "retained", kind: outcome.kind };
  }

  // FLUSH: clean | no-repo | recovered | gone. Terminate the sandbox (best-effort),
  // then record the terminal lifecycle state.
  try {
    await runInTenantScope(
      { orgId: c.org_id, workspaceId: c.workspace_id },
      () => agentSandboxStopHandler({ sessionId: c.public_id }, ctx),
    );
  } catch (err) {
    // A gone/already-stopped sandbox is fine — we still mark the row flushed.
    logger.debug(
      { err, sessionId: c.public_id },
      "agent.sandbox-reaper: terminate best-effort",
    );
  }

  // Terminal state is written HERE, not left to the best-effort stop above: even
  // when the stop handler or its provider call throws, a flushed (cleaned-out)
  // sandbox must NEVER linger in lists as idle/running. Soft-delete the row and
  // flip status → stopped alongside the recovery columns so retirement is
  // guaranteed by the reaper itself, independent of the terminate call.
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.sandboxSessions)
      .set({
        status: "stopped",
        deletedAt: new Date(),
        flushedAt: new Date(),
        recoveryStatus:
          outcome.kind === "recovered"
            ? "recovered"
            : outcome.kind === "gone"
              ? "failed"
              : "none",
        recoveryBranch: outcome.branch ?? null,
        recoveryCommit: outcome.commit ?? null,
        recoveryError: outcome.kind === "gone" ? (outcome.error ?? null) : null,
        recoveredAt: outcome.kind === "recovered" ? new Date() : null,
        dirty: outcome.dirty,
        dirtyCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.sandboxSessions.id, c.id));
  });

  return { action: "flushed", kind: outcome.kind };
}
