/**
 * @deprecated Superseded by `./file-lock-lease.ts` (Postgres lease, ADR-021 §5).
 * A Neo4j-backed lock is UNSOUND for mutual exclusion: the graph sync path is
 * asynchronous (ADR-018), so a lock written here is invisible to a concurrent
 * agent for the duration of sync lag. `agent.repo.edit` now injects
 * `createFileLeaseLockAdapter`; Neo4j carries only an async lineage projection
 * of the Postgres leases. This file is retained for reference only — do not
 * wire it into new call sites.
 *
 * In-app FileLockProvider — the platform implementation of the
 * `@oxagen/agent-engine` file-lock port (docs/specs/agent-file-locking/plan.md),
 * backed by the tenant-scoped Neo4j `HOLDS_LOCK` edge in `@oxagen/ontology`.
 *
 * Injected wherever `runTurn`/`runCodingAgent` is given a real `Workspace`
 * (today: `agent.repo.edit`'s handler) so `write_file`/`edit_file` in
 * `packages/agent-engine/src/tools.ts` can acquire before the real write and
 * release after — the SINGLE wiring point protects every caller (chat's tool
 * call into `agent.repo.edit`, a fleet subagent child dispatching the same
 * capability, or a direct CLI-less platform invocation) without duplicated
 * per-caller locking code.
 *
 * All three methods degrade to fail-soft/deny rather than throwing — a Neo4j
 * outage must never crash a tool call. `acquire()` degrading to
 * `granted: false` is the SAFE direction (denies a write rather than risking
 * an unguarded one); `release`/`releaseAll` degrading to a no-op relies on
 * the lock's own TTL sweep as the backstop, exactly as documented on the
 * `FileLockProvider` port.
 */
import pino from "pino";
import {
  acquireFileLock,
  releaseFileLock,
  releaseFileLocksByExecution,
} from "@oxagen/ontology";
import type { FileLockProvider, FileLockGrant } from "@oxagen/agent-engine";
import { toNaturalKey } from "./natural-key";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.file-lock" },
});

const DENIED_ON_ERROR: FileLockGrant = {
  granted: false,
  lockId: "",
  heldBy: null,
  blockedUntil: null,
};

export interface FileLockAdapterArgs {
  /** GitHub owner (org or user) — feeds `toNaturalKey` so the lock and the lineage edge key off the identical naturalKey. */
  owner?: string;
  /** GitHub repo name. */
  repo?: string;
  /** Carried onto the `HOLDS_LOCK` edge (docs/specs/agent-file-locking/plan.md §3 — org+workspace scoping on the edge). */
  workspaceId: string;
}

export function createFileLockAdapter(
  args: FileLockAdapterArgs,
): FileLockProvider {
  const { owner, repo, workspaceId } = args;

  return {
    async acquire({
      path,
      agentId,
      executionId,
      action,
    }): Promise<FileLockGrant> {
      const naturalKey = toNaturalKey(path, owner, repo);
      try {
        return await acquireFileLock({
          naturalKey,
          agentId,
          executionId,
          workspaceId,
          action,
        });
      } catch (err) {
        // Fail SOFT toward denial — a graph outage must never let a write
        // proceed unguarded. tools.ts's withFileLock retries a denial a
        // bounded number of times, then surfaces a clear "Blocked" tool
        // result rather than crashing the turn.
        logger.warn(
          { err, path, agentId, executionId },
          "file-lock: acquire failed — denying (fail-soft)",
        );
        return DENIED_ON_ERROR;
      }
    },

    async release({ lockId, agentId }): Promise<void> {
      if (!lockId) return; // nothing was actually acquired (a denied/degraded grant)
      try {
        await releaseFileLock({ lockId, agentId });
      } catch (err) {
        // Best-effort — the lock's own TTL (default 300s) and the turn-end
        // releaseAll backstop both still apply.
        logger.warn(
          { err, lockId, agentId },
          "file-lock: release failed — relying on TTL/backstop",
        );
      }
    },

    async releaseAll(executionId: string): Promise<void> {
      try {
        await releaseFileLocksByExecution({ executionId });
      } catch (err) {
        logger.warn(
          { err, executionId },
          "file-lock: releaseAll failed — relying on TTL sweep",
        );
      }
    },
  };
}
