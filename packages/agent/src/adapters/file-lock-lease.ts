/**
 * Postgres-backed FileLockProvider — the platform implementation of the
 * `@oxagen/agent-engine` file-lock port, backed by the transactional lease in
 * `@oxagen/agent`'s `file-lock/lease.ts` (ADR-021 §5).
 *
 * Locks are mutual-exclusion state, so they must live in Postgres. A
 * graph-backed lock is eventually consistent and therefore invisible during
 * projection lag.
 *
 * Injected wherever a turn gets a real workspace (today:
 * `agent.repo.edit`'s handler) so `write_file`/`edit_file` in
 * `packages/agent-engine/src/tools.ts` acquire before the real write and
 * release after — the SINGLE enforcement point protects every caller.
 *
 * All three methods degrade to fail-soft/deny rather than throwing, mirroring
 * the port contract: `acquire()` → `granted: false` (the SAFE direction — deny
 * a write rather than risk an unguarded one); `release`/`releaseAll` → no-op
 * (the lease TTL + turn-end batch release are the backstop).
 */
import pino from "pino";
import type { FileLockProvider, FileLockGrant } from "@oxagen/agent-engine";
import {
  acquireFileLease,
  releaseFileLease,
  releaseFileLeasesByExecution,
} from "../file-lock/lease";
import { toFileResourceKey } from "../file-lock/resource-key";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.file-lock-lease" },
});

const DENIED_ON_ERROR: FileLockGrant = {
  granted: false,
  lockId: "",
  heldBy: null,
  blockedUntil: null,
  fencingToken: null,
};

export interface FileLeaseLockAdapterArgs {
  orgId: string;
  workspaceId: string;
  /** GitHub owner (org or user), used to make the resource key repository-scoped. */
  owner?: string;
  /** GitHub repo name. */
  repo?: string;
}

export function createFileLeaseLockAdapter(
  args: FileLeaseLockAdapterArgs,
): FileLockProvider {
  const { orgId, workspaceId, owner, repo } = args;

  return {
    async acquire({
      path,
      agentId,
      executionId,
      action,
    }): Promise<FileLockGrant> {
      const resourceKey = toFileResourceKey(path, owner, repo);
      try {
        const result = await acquireFileLease({
          orgId,
          workspaceId,
          resourceKeys: [resourceKey],
          holder: agentId,
          executionId,
          // The port's action is free-text; the lease stores a closed set.
          action: action === "read" ? "read" : "write",
        });
        const lease = result.acquired[0];
        if (lease) {
          return {
            granted: true,
            lockId: lease.lockId,
            heldBy: null,
            blockedUntil: null,
            fencingToken: lease.fencingToken,
          };
        }
        const conflict = result.conflicts[0];
        return {
          granted: false,
          lockId: "",
          heldBy: conflict?.holder ?? null,
          blockedUntil: conflict?.expiresAt ?? null,
          fencingToken: null,
        };
      } catch (err) {
        // Fail SOFT toward denial — a DB outage must never let a write proceed
        // unguarded. tools.ts retries a denial a bounded number of times, then
        // surfaces a clear "Blocked" tool result rather than crashing the turn.
        logger.warn(
          { err, resourceKey, agentId, executionId },
          "file-lock lease: acquire failed — denying (fail-soft)",
        );
        return DENIED_ON_ERROR;
      }
    },

    async release({ lockId, agentId }): Promise<void> {
      if (!lockId) return; // nothing acquired (a denied/degraded grant)
      try {
        await releaseFileLease({ orgId, workspaceId, lockId, holder: agentId });
      } catch (err) {
        // Best-effort — the lease TTL and the turn-end releaseAll both still apply.
        logger.warn(
          { err, lockId, agentId },
          "file-lock lease: release failed — relying on TTL/backstop",
        );
      }
    },

    async releaseAll(executionId: string): Promise<void> {
      try {
        await releaseFileLeasesByExecution({ orgId, workspaceId, executionId });
      } catch (err) {
        logger.warn(
          { err, executionId },
          "file-lock lease: releaseAll failed — relying on TTL sweep",
        );
      }
    },
  };
}
