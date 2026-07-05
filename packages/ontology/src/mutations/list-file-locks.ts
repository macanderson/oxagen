import { scopedSession } from "../tenant";
import { EdgeTypes } from "../types";

export interface FileLockRecord {
  lockId: string;
  naturalKey: string;
  agentId: string;
  acquiredAt: number;
  expiresAt: number;
  workspaceId: string;
  action: string;
  executionId: string;
}

export interface ListFileLocksInput {
  /** Restrict to live locks on this exact naturalKey. Omit to list every live lock in the org. */
  naturalKey?: string;
}

export interface ListFileLocksResult {
  locks: FileLockRecord[];
}

/**
 * Introspection: who holds what (docs/specs/agent-file-locking/plan.md §7) —
 * lists every currently-LIVE (`expiresAt > now`) `HOLDS_LOCK` edge in the
 * tenant, optionally filtered to one file. Useful for debugging a stuck
 * fleet: a lock that outlives its owning turn (crash before release) is
 * visible here until its TTL lapses or the sweep reaps it.
 */
export async function listFileLocks(input: ListFileLocksInput = {}): Promise<ListFileLocksResult> {
  const now = Date.now();
  const neo4j = scopedSession();
  try {
    const result = await neo4j.run(
      `MATCH (a:Agent {orgId: $orgId})-[l:${EdgeTypes.HOLDS_LOCK}]->(f:SourceFile {orgId: $orgId})
       WHERE l.expiresAt > $now
         AND ($naturalKey IS NULL OR f.naturalKey = $naturalKey)
       RETURN l.lockId AS lockId, f.naturalKey AS naturalKey, a.id AS agentId,
              l.acquiredAt AS acquiredAt, l.expiresAt AS expiresAt,
              l.workspaceId AS workspaceId, l.action AS action, l.executionId AS executionId
       ORDER BY l.acquiredAt DESC`,
      { now, naturalKey: input.naturalKey ?? null },
    );
    const locks = result.records.map((record) => ({
      lockId: String(record.get("lockId")),
      naturalKey: String(record.get("naturalKey")),
      agentId: String(record.get("agentId")),
      acquiredAt: Number(record.get("acquiredAt")),
      expiresAt: Number(record.get("expiresAt")),
      workspaceId: String(record.get("workspaceId")),
      action: String(record.get("action")),
      executionId: String(record.get("executionId")),
    }));
    return { locks };
  } finally {
    await neo4j.close();
  }
}
