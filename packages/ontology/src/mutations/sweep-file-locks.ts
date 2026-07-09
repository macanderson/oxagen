import { session } from "../client";
import { EdgeTypes } from "../types";

export interface SweepFileLocksResult {
  sweptCount: number;
}

/**
 * Backstop cleanup for crashed/dead agents (docs/specs/agent-file-locking/plan.md
 * §6): deletes every `HOLDS_LOCK` edge whose `expiresAt` has already passed.
 * Lazy expiry (the `l.expiresAt > $now` predicate in {@link acquireFileLock})
 * already makes an expired lock invisible to new acquires — this sweep only
 * reclaims the orphaned graph rows so they don't accumulate forever.
 *
 * System-wide, NOT tenant-scoped: a periodic cron has no tenant context (same
 * shape as `agent.lease-sweep`'s `withSystemDb` sweep over Postgres
 * `lease_expires_at`), so this uses the raw, unscoped `session()` — mirroring
 * the precedent in `migrate.ts` for cross-tenant maintenance Cypher — rather
 * than `scopedSession()`, which requires an active tenant scope and enforces
 * an `orgId` filter that would defeat a cross-org sweep.
 */
export async function sweepExpiredFileLocks(now: number = Date.now()): Promise<SweepFileLocksResult> {
  const s = session();
  try {
    const result = await s.run(
      `MATCH ()-[l:${EdgeTypes.HOLDS_LOCK}]->()
       WHERE l.expiresAt < $now
       WITH collect(l) AS locks, count(l) AS sweptCount
       FOREACH (lock IN locks | DELETE lock)
       RETURN sweptCount`,
      { now },
    );
    const record = result.records[0];
    const sweptCount = record ? Number(record.get("sweptCount") ?? 0) : 0;
    return { sweptCount };
  } finally {
    await s.close();
  }
}
