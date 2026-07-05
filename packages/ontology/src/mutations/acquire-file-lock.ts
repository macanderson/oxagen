import { scopedSession } from "../tenant";
import { EdgeTypes } from "../types";

/**
 * Default lock lease, mirroring `IntentLedger`'s in-memory TTL
 * (`packages/engram/src/blackboard/intent.ts`) so the graph-backed lock and
 * the (now superseded) in-process lock expire on the same cadence.
 */
export const DEFAULT_FILE_LOCK_TTL_MS = 300_000;

export interface AcquireFileLockInput {
  /**
   * The `:SourceFile` natural key — same value `graph-sync.ts`'s
   * `toNaturalKey(path, owner, repo)` produces, so a locked file and a
   * touched-file lineage edge are the same node.
   */
  naturalKey: string;
  /**
   * Identity of the lock holder. Two different concurrently-running
   * turns/subagent children MUST pass different `agentId`s so they see each
   * other as conflicting holders; repeated acquires from the SAME `agentId`
   * (e.g. the same coding-agent turn editing a file twice) renew instead of
   * conflicting.
   */
  agentId: string;
  /** Correlates every lock this execution/turn holds, for batch release. */
  executionId: string;
  workspaceId: string;
  /** Free-text action label stored on the edge (default "write"). */
  action?: string;
  /** Lease length in ms (default {@link DEFAULT_FILE_LOCK_TTL_MS}). */
  ttlMs?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number;
  /** Injectable for tests; defaults to a random UUID. */
  lockId?: string;
}

export interface AcquireFileLockResult {
  granted: boolean;
  lockId: string;
  /** The conflicting holder's agentId, when `granted` is false. */
  heldBy: string | null;
  /** Epoch-ms the conflicting lock expires at, when `granted` is false. */
  blockedUntil: number | null;
}

/**
 * Atomically acquire an exclusive, tenant-scoped, TTL-bounded lock on a file
 * (docs/specs/agent-file-locking/plan.md §4). Succeeds only when no OTHER
 * agent holds a live (`expiresAt > now`) lock on the same `:SourceFile`.
 *
 * Re-acquiring with the SAME `agentId` renews `expiresAt` (idempotent
 * renewal) instead of conflicting with itself.
 *
 * Atomicity — two adaptations from the plan doc's literal §4 Cypher, both
 * verified against a real local Neo4j 5.24-community instance:
 *   1. Neo4j only takes the MERGE-time lock that serializes two concurrent
 *      transactions racing to create/match the SAME node when a UNIQUENESS
 *      CONSTRAINT backs the merged properties — without one, two concurrent
 *      `acquireFileLock()` calls for the SAME file could both pass their
 *      MERGE + conflict-check read before either committed, and both be
 *      granted. `schema.cypher` now carries a composite uniqueness
 *      constraint on `SourceFile(naturalKey, orgId)` (Neo4j Community DOES
 *      support composite/multi-property uniqueness constraints — verified
 *      directly against the container) so the second transaction's MERGE
 *      blocks until the first commits, and then correctly observes its
 *      HOLDS_LOCK edge.
 *   2. The doc's plain `CALL { ... }` subquery silently ELIMINATES the outer
 *      row when its inner `WITH f WHERE l IS NULL` filters to zero rows (the
 *      conflict case) — a bare `CALL` behaves like an inner join, not
 *      `OPTIONAL MATCH`. This is `OPTIONAL CALL { ... }` (Neo4j 5.21+, present
 *      on this instance) instead, so a denied acquire still returns its one
 *      row with `granted:false` / `heldBy` / `blockedUntil` populated, rather
 *      than an empty result set.
 */
export async function acquireFileLock(input: AcquireFileLockInput): Promise<AcquireFileLockResult> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_FILE_LOCK_TTL_MS;
  const lockId = input.lockId ?? crypto.randomUUID();
  const action = input.action ?? "write";

  const neo4j = scopedSession();
  try {
    const result = await neo4j.run(
      `MERGE (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
       ON CREATE SET
         f.path = $naturalKey,
         f.displayName = $naturalKey,
         f.is_system = true,
         f.createdAt = datetime()
       WITH f
       OPTIONAL MATCH (other:Agent {orgId: $orgId})-[l:${EdgeTypes.HOLDS_LOCK}]->(f)
         WHERE l.expiresAt > $now AND other.id <> $agentId
       WITH f, l, other
       OPTIONAL CALL {
         WITH f, l
         WITH f WHERE l IS NULL
         MERGE (a:Agent {id: $agentId, orgId: $orgId})
         MERGE (a)-[h:${EdgeTypes.HOLDS_LOCK}]->(f)
         SET h.lockId = $lockId,
             h.acquiredAt = $now,
             h.expiresAt = $now + $ttlMs,
             h.workspaceId = $workspaceId,
             h.action = $action,
             h.executionId = $executionId
         RETURN h
       }
       RETURN CASE WHEN other IS NULL THEN true ELSE false END AS granted,
              other.id AS heldBy,
              l.expiresAt AS blockedUntil`,
      {
        naturalKey: input.naturalKey,
        agentId: input.agentId,
        now,
        ttlMs,
        lockId,
        action,
        workspaceId: input.workspaceId,
        executionId: input.executionId,
      },
    );

    const record = result.records[0];
    // Defensive: the MERGE/CALL chain always produces exactly one row. An
    // empty result set would mean the driver call itself failed silently —
    // treat that as "not granted" rather than throwing mid-lock-flow, since
    // callers (tool execute()) already fail soft on a denied acquire.
    if (!record) {
      return { granted: false, lockId, heldBy: null, blockedUntil: null };
    }

    const granted = record.get("granted") === true;
    const heldByRaw: unknown = record.get("heldBy");
    const blockedUntilRaw: unknown = record.get("blockedUntil");
    return {
      granted,
      lockId,
      heldBy: heldByRaw == null ? null : String(heldByRaw),
      blockedUntil: blockedUntilRaw == null ? null : Number(blockedUntilRaw),
    };
  } finally {
    await neo4j.close();
  }
}
