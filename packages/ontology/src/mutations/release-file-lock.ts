import { scopedSession } from "../tenant";
import { EdgeTypes } from "../types";

export interface ReleaseFileLockInput {
  lockId: string;
  /** An agent can only release its OWN lock. */
  agentId: string;
}

export interface ReleaseFileLockResult {
  released: boolean;
}

/**
 * Explicit release on task completion (docs/specs/agent-file-locking/plan.md
 * §5): DELETE the `HOLDS_LOCK` edge matching `lockId` AND the releasing
 * agent's id — a lock can only be released by the agent that holds it.
 * Idempotent: releasing an already-released/expired/nonexistent lock is a
 * no-op that returns `released: false`, never an error.
 */
export async function releaseFileLock(
  input: ReleaseFileLockInput,
): Promise<ReleaseFileLockResult> {
  const neo4j = scopedSession();
  try {
    const result = await neo4j.run(
      `MATCH (a:Agent {id: $agentId, orgId: $orgId})-[h:${EdgeTypes.HOLDS_LOCK} {lockId: $lockId}]->(f:SourceFile {orgId: $orgId})
       WITH collect(h) AS locks, count(h) AS deletedCount
       FOREACH (lock IN locks | DELETE lock)
       RETURN deletedCount`,
      { agentId: input.agentId, lockId: input.lockId },
    );
    const record = result.records[0];
    const deletedCount = record ? Number(record.get("deletedCount") ?? 0) : 0;
    return { released: deletedCount > 0 };
  } finally {
    await neo4j.close();
  }
}

export interface ForceReleaseFileLockInput {
  lockId: string;
}

export interface ForceReleaseFileLockResult {
  released: boolean;
}

/**
 * Admin/debug force-release (docs/specs/agent-file-locking/plan.md §7): the
 * `agent.file.lock.release` capability is gated to Owner/Admin precisely so
 * an operator can clear a lock a crashed agent left behind WITHOUT knowing
 * the original holder's internal `agentId` — unlike {@link releaseFileLock},
 * this does NOT check the holder's identity, only `lockId`. Never expose
 * this as the per-call release inside `tools.ts`; that path must keep the
 * "an agent can only release its own lock" invariant.
 */
export async function forceReleaseFileLock(
  input: ForceReleaseFileLockInput,
): Promise<ForceReleaseFileLockResult> {
  const neo4j = scopedSession();
  try {
    const result = await neo4j.run(
      `MATCH (:Agent {orgId: $orgId})-[h:${EdgeTypes.HOLDS_LOCK} {lockId: $lockId}]->(:SourceFile {orgId: $orgId})
       WITH collect(h) AS locks, count(h) AS deletedCount
       FOREACH (lock IN locks | DELETE lock)
       RETURN deletedCount`,
      { lockId: input.lockId },
    );
    const record = result.records[0];
    const deletedCount = record ? Number(record.get("deletedCount") ?? 0) : 0;
    return { released: deletedCount > 0 };
  } finally {
    await neo4j.close();
  }
}

export interface ReleaseFileLocksByExecutionInput {
  executionId: string;
}

export interface ReleaseFileLocksByExecutionResult {
  releasedCount: number;
}

/**
 * Batch release on agent-turn-end (docs/specs/agent-file-locking/plan.md
 * §5): delete every `HOLDS_LOCK` edge stamped with `executionId`, so a turn
 * never leaks locks past its own lifetime regardless of how many files it
 * touched. Called from the turn's `finally`, fire-and-forget.
 */
export async function releaseFileLocksByExecution(
  input: ReleaseFileLocksByExecutionInput,
): Promise<ReleaseFileLocksByExecutionResult> {
  const neo4j = scopedSession();
  try {
    const result = await neo4j.run(
      `MATCH (a:Agent {orgId: $orgId})-[h:${EdgeTypes.HOLDS_LOCK} {executionId: $executionId}]->(f:SourceFile {orgId: $orgId})
       WITH collect(h) AS locks, count(h) AS deletedCount
       FOREACH (lock IN locks | DELETE lock)
       RETURN deletedCount`,
      { executionId: input.executionId },
    );
    const record = result.records[0];
    const releasedCount = record ? Number(record.get("deletedCount") ?? 0) : 0;
    return { releasedCount };
  } finally {
    await neo4j.close();
  }
}
