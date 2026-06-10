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
}): Promise<MemoryRow[]> {
  const s = scopedSession();
  try {
    const minRank = WEIGHT_RANK[args.minWeight];
    const result = await s.run(
      /* cypher */ `
        CALL db.index.vector.queryNodes('agent_memory_embedding', $limit, $embedding)
        YIELD node, score
        WHERE node.orgId = $orgId
          AND node.workspaceId = $workspaceId
          AND (CASE node.weight WHEN 'critical' THEN 2 WHEN 'high' THEN 1 ELSE 0 END) >= $minRank
          AND ($nodeRef IS NULL OR node.nodeRef = $nodeRef)
        RETURN
          node.id AS id,
          node.nodeRef AS nodeRef,
          node.weight AS weight,
          node.kind AS kind,
          node.lesson AS lesson,
          node.source AS source,
          score,
          toString(node.createdAt) AS createdAt
        ORDER BY score DESC
        LIMIT $limit
      `,
      {
        embedding: args.embedding,
        minRank,
        nodeRef: args.nodeRef ?? null,
        limit: BigInt(args.limit),
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
          m.createdAt = datetime()
        ON MATCH SET
          m.weight = $weight,
          m.kind = $kind,
          m.source = $source,
          m.embedding = $embedding,
          m.updatedAt = datetime()
        WITH m
        OPTIONAL MATCH (target { id: $nodeRef })
        FOREACH (_ IN CASE WHEN target IS NULL THEN [] ELSE [1] END |
          MERGE (target)-[:REMEMBERS]->(m)
        )
        WITH m
        UNWIND $relatedNodeIds AS nid
        OPTIONAL MATCH (kn:KnowledgeNode {publicId: nid, orgId: $orgId})
        FOREACH (_ IN CASE WHEN kn IS NULL THEN [] ELSE [1] END |
          MERGE (m)-[:ABOUT]->(kn)
        )
        WITH m, count(kn) AS edgesCreated
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
    const id = result.records[0]?.get("id") as string;
    const edgesCreated = Number(result.records[0]?.get("edgesCreated") ?? 0);
    return { memoryId: id, edgesCreated };
  } finally {
    await s.close();
  }
}
