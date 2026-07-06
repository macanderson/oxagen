import { scopedSession } from "../tenant";
import { EdgeTypes } from "../types";

export interface ProjectFileLockInput {
  /** The `:SourceFile` natural key — same value graph-sync's toNaturalKey produces, so the projection and the touched-file lineage share the node. */
  resourceKey: string;
  /** Lock-holder identity (agent/session/mission/fleet-task id). */
  holder: string;
  /** Correlates the projection with the turn/execution that held the lease. */
  executionId: string;
  /** "read" | "write" (free-text label). */
  action: string;
  /** "acquired" | "released" — released stamps `releasedAt` for hot-file analytics. */
  event: "acquired" | "released";
  /** The lease's fencing token (present on acquire). */
  fencingToken?: number;
  /** Epoch-ms the lease expires (present on acquire). */
  expiresAt?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number;
}

export interface ProjectFileLockResult {
  projected: boolean;
}

/**
 * Async LINEAGE projection of a Postgres file lease onto Neo4j (ADR-021 §5,
 * mirroring the ADR-012 connector dual-write: Postgres = source of truth, Neo4j
 * = derived graph index). MERGEs an `(:Agent)-[:LOCKED]->(:SourceFile)` edge for
 * hot-file analytics and conflict prediction (the planner reads this to shard
 * work so locks are rarely contended). This is NEVER load-bearing for mutual
 * exclusion — the lock authority is the Postgres lease. Idempotent: MERGE
 * semantics mean re-runs never duplicate the edge.
 */
export async function projectFileLockToGraph(input: ProjectFileLockInput): Promise<ProjectFileLockResult> {
  const now = input.now ?? Date.now();
  const neo4j = scopedSession();
  try {
    await neo4j.run(
      `MERGE (f:SourceFile {naturalKey: $resourceKey, orgId: $orgId})
       ON CREATE SET
         f.path = $resourceKey,
         f.displayName = $resourceKey,
         f.is_system = true,
         f.createdAt = datetime()
       MERGE (a:Agent {id: $holder, orgId: $orgId})
       MERGE (a)-[r:${EdgeTypes.LOCKED}]->(f)
       SET r.action = $action,
           r.executionId = $executionId,
           r.workspaceId = $workspaceId
       FOREACH (_ IN CASE WHEN $event = 'acquired' THEN [1] ELSE [] END |
         SET r.acquiredAt = $now,
             r.fencingToken = $fencingToken,
             r.expiresAt = $expiresAt,
             r.releasedAt = null)
       FOREACH (_ IN CASE WHEN $event = 'released' THEN [1] ELSE [] END |
         SET r.releasedAt = $now)`,
      {
        resourceKey: input.resourceKey,
        holder: input.holder,
        executionId: input.executionId,
        action: input.action,
        event: input.event,
        now,
        fencingToken: input.fencingToken ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    );
    return { projected: true };
  } finally {
    await neo4j.close();
  }
}
