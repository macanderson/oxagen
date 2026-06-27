import { scopedSession } from "@oxagen/ontology";

export interface MemoryRow {
  id: string;
  nodeRef: string;
  weight: "low" | "high" | "critical";
  kind: string;
  lesson: string;
  source: string;
  score: number;
  createdAt: string;
  confidence: number;
  lastReinforcedAt: string | null;
}

const WEIGHT_RANK: Record<string, number> = { low: 0, high: 1, critical: 2 };

// Vector recall over AgentMemory. The 1536-dim index is provisioned by
// the foundation migration; we filter by tenant + workspace + weight at
// query time so the result set is already scoped before we score it.
// orgId/workspaceId are injected automatically by scopedSession() from the
// active tenant scope — no need to thread them through the function args.
export async function recallMemories(args: {
  embedding: number[];
  minWeight: "low" | "high" | "critical";
  limit: number;
  nodeRef?: string;
  recallThreshold?: number;
}): Promise<MemoryRow[]> {
  const s = scopedSession();
  try {
    const minRank = WEIGHT_RANK[args.minWeight];
    const recallThreshold = args.recallThreshold ?? 0;
    const result = await s.run(
      /* cypher */ `
        CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
        YIELD node, score
        WHERE node.orgId = $orgId
          AND node.workspaceId = $workspaceId
          AND (CASE node.weight WHEN 'critical' THEN 2 WHEN 'high' THEN 1 ELSE 0 END) >= $minRank
          AND ($nodeRef IS NULL OR node.nodeRef = $nodeRef)
          AND coalesce(node.confidence, 1.0) >= $recallThreshold
        RETURN
          node.id AS id,
          node.nodeRef AS nodeRef,
          node.weight AS weight,
          node.kind AS kind,
          node.lesson AS lesson,
          node.source AS source,
          score,
          toString(node.createdAt) AS createdAt,
          node.confidence AS confidence,
          toString(node.lastReinforcedAt) AS lastReinforcedAt
        ORDER BY score DESC
        LIMIT $limit
      `,
      {
        embedding: args.embedding,
        minRank,
        nodeRef: args.nodeRef ?? null,
        limit: BigInt(args.limit),
        recallThreshold,
      },
    );
    /* eslint-disable @typescript-eslint/no-unsafe-assignment -- neo4j-driver Record.get() is typed as `any`; shape is guaranteed by the Cypher projection above. */
    return result.records.map((r) => ({
      id: r.get("id"),
      nodeRef: r.get("nodeRef"),
      weight: r.get("weight"),
      kind: r.get("kind"),
      lesson: r.get("lesson"),
      source: r.get("source"),
      score: Number(r.get("score")),
      createdAt: r.get("createdAt"),
      confidence: Number(r.get("confidence") ?? 1.0),
      lastReinforcedAt: r.get("lastReinforcedAt") ?? null,
    }));
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  } finally {
    await s.close();
  }
}

export interface WriteMemoryArgs {
  nodeRef: string;
  embedding: number[];
  weight: "low" | "high" | "critical";
  kind: string;
  lesson: string;
  source: string;
  /** IDs of KnowledgeNode entities this memory is about — creates :ABOUT edges. */
  relatedNodeIds?: string[];
}

// MERGE on (orgId, workspaceId, nodeRef, lesson) so identical writes
// from repeated reflection don't accumulate duplicates.
// orgId/workspaceId are injected automatically by scopedSession() from the
// active tenant scope — no need to thread them through the function args.
export async function writeMemory(
  args: WriteMemoryArgs,
): Promise<{ memoryId: string; edgesCreated: number }> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MERGE (m:AgentMemory {
          orgId: $orgId,
          workspaceId: $workspaceId,
          nodeRef: $nodeRef,
          lesson: $lesson
        })
        ON CREATE SET
          m.id = randomUUID(),
          m.weight = $weight,
          m.kind = $kind,
          m.source = $source,
          m.embedding = $embedding,
          m.confidence = 1.0,
          m.lastReinforcedAt = datetime(),
          m.createdAt = datetime()
        ON MATCH SET
          m.weight = $weight,
          m.kind = $kind,
          m.source = $source,
          m.embedding = $embedding,
          m.updatedAt = datetime()
        WITH m
        OPTIONAL MATCH (target { id: $nodeRef, orgId: $orgId })
        FOREACH (_ IN CASE WHEN target IS NULL THEN [] ELSE [1] END |
          MERGE (target)-[:REMEMBERS]->(m)
        )
        WITH m
        CALL {
          WITH m
          UNWIND $relatedNodeIds AS nid
          OPTIONAL MATCH (kn:KnowledgeNode {publicId: nid, orgId: $orgId})
          FOREACH (_ IN CASE WHEN kn IS NULL THEN [] ELSE [1] END |
            MERGE (m)-[:ABOUT]->(kn)
          )
          RETURN count(kn) AS edgesCreated
        }
        RETURN m.id AS id, edgesCreated
      `,
      {
        nodeRef: args.nodeRef,
        lesson: args.lesson,
        weight: args.weight,
        kind: args.kind,
        source: args.source,
        embedding: args.embedding,
        relatedNodeIds: args.relatedNodeIds ?? [],
      },
    );
    const id = result.records[0]?.get("id") as string | undefined;
    if (!id) {
      // The MERGE always produces an m row, and the edge-count subquery preserves
      // it even when relatedNodeIds is empty — a missing record means the write
      // genuinely failed, so surface it rather than returning an undefined id.
      throw new Error("writeMemory: MERGE returned no record");
    }
    const edgesCreated = Number(result.records[0]?.get("edgesCreated") ?? 0);
    return { memoryId: id, edgesCreated };
  } finally {
    await s.close();
  }
}

/**
 * Reinforce a memory by adding `reinforcementAmount` to its confidence,
 * capped at 1.0. Sets `lastReinforcedAt` to now.
 *
 * orgId/workspaceId are injected automatically by scopedSession() from the
 * active tenant scope.
 */
export async function reinforceMemory(args: {
  memoryId: string;
  reinforcementAmount: number;
}): Promise<{ confidence: number }> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        SET m.confidence = CASE WHEN coalesce(m.confidence, 1.0) + $amount > 1.0
                            THEN 1.0
                            ELSE coalesce(m.confidence, 1.0) + $amount
                           END,
            m.lastReinforcedAt = datetime()
        RETURN m.confidence AS confidence
      `,
      { memoryId: args.memoryId, amount: args.reinforcementAmount },
    );
     
    const confidence = Number(result.records[0]?.get("confidence") ?? 1.0);
     
    return { confidence };
  } finally {
    await s.close();
  }
}

/**
 * Apply exponential decay to a memory by setting its confidence to `newConfidence`.
 * Callers are responsible for computing the decay formula:
 *   confidence * exp(-ln(2) / halfLifeDays * daysSinceReinforced)
 *
 * orgId/workspaceId are injected automatically by scopedSession() from the
 * active tenant scope.
 */
export async function applyDecayToMemory(args: {
  memoryId: string;
  newConfidence: number;
}): Promise<void> {
  const s = scopedSession();
  try {
    await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        SET m.confidence = $newConfidence
      `,
      { memoryId: args.memoryId, newConfidence: args.newConfidence },
    );
  } finally {
    await s.close();
  }
}
