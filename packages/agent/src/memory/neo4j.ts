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

/** A fully-projected AgentMemory record for browse/list surfaces. */
export interface MemoryListRow {
  id: string;
  publicId: string;
  nodeRef: string;
  weight: "low" | "high" | "critical";
  kind: string;
  lesson: string;
  source: string;
  confidence: number;
  createdAt: string;
  lastReinforcedAt: string | null;
}

/**
 * Browse AgentMemory nodes for the active tenant, newest first, with optional
 * weight/kind/node filters. Unlike `recallMemories`, this does no vector search
 * — it is the non-semantic enumeration backing `agent.memory.list` and the
 * Knowledge → Memories surface. Returns the page plus the unpaged `total` so
 * callers can render accurate counts.
 *
 * orgId/workspaceId are injected automatically by scopedSession() from the
 * active tenant scope.
 */
export async function listMemories(args: {
  limit: number;
  offset: number;
  nodeRef?: string;
  minWeight?: "low" | "high" | "critical";
  kind?: string;
}): Promise<{ memories: MemoryListRow[]; total: number }> {
  const s = scopedSession();
  const minRank =
    args.minWeight !== undefined ? WEIGHT_RANK[args.minWeight] : null;
  // Shared predicate so the count and the page filter identically.
  const where = /* cypher */ `
    WHERE ($nodeRef IS NULL OR m.nodeRef = $nodeRef)
      AND ($minRank IS NULL OR (CASE m.weight WHEN 'critical' THEN 2 WHEN 'high' THEN 1 ELSE 0 END) >= $minRank)
      AND ($kind IS NULL OR m.kind = $kind)
  `;
  // orgId/workspaceId are auto-injected by scopedSession() — do not pass them.
  const params = {
    nodeRef: args.nodeRef ?? null,
    minRank,
    kind: args.kind ?? null,
  };
  try {
    const countResult = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
        ${where}
        RETURN count(m) AS total
      `,
      params,
    );
    const total = Number(countResult.records[0]?.get("total") ?? 0);

    const pageResult = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
        ${where}
        RETURN
          m.id AS id,
          coalesce(m.publicId, m.id) AS publicId,
          coalesce(m.nodeRef, '') AS nodeRef,
          m.weight AS weight,
          m.kind AS kind,
          m.lesson AS lesson,
          m.source AS source,
          coalesce(m.confidence, 1.0) AS confidence,
          toString(m.createdAt) AS createdAt,
          toString(m.lastReinforcedAt) AS lastReinforcedAt
        ORDER BY m.createdAt DESC
        SKIP $offset
        LIMIT $limit
      `,
      { ...params, offset: BigInt(args.offset), limit: BigInt(args.limit) },
    );
    /* eslint-disable @typescript-eslint/no-unsafe-assignment -- neo4j-driver Record.get() is typed as `any`; shape is guaranteed by the Cypher projection above. */
    const memories: MemoryListRow[] = pageResult.records.map((r) => ({
      id: r.get("id"),
      publicId: r.get("publicId"),
      nodeRef: r.get("nodeRef") ?? "",
      weight: r.get("weight"),
      kind: r.get("kind"),
      lesson: r.get("lesson"),
      source: r.get("source"),
      confidence: Number(r.get("confidence") ?? 1.0),
      createdAt: r.get("createdAt"),
      lastReinforcedAt: r.get("lastReinforcedAt") ?? null,
    }));
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return { memories, total };
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
          m.publicId = randomUUID(),
          m:GraphNode,
          m.is_system = true,
          m.label = 'AgentMemory',
          m.displayName = left($lesson, 200),
          m.weight = $weight,
          m.kind = $kind,
          m.source = $source,
          m.embedding = $embedding,
          m.confidence = 1.0,
          m.lastReinforcedAt = datetime(),
          m.createdAt = datetime()
        ON MATCH SET
          m:GraphNode,
          m.is_system = true,
          m.label = 'AgentMemory',
          m.displayName = left($lesson, 200),
          m.publicId = coalesce(m.publicId, randomUUID()),
          m.weight = $weight,
          m.kind = $kind,
          m.source = $source,
          m.embedding = $embedding,
          m.updatedAt = datetime()
        WITH m
        OPTIONAL MATCH (target { id: $nodeRef, orgId: $orgId })
        FOREACH (_ IN CASE WHEN target IS NULL THEN [] ELSE [1] END |
          MERGE (target)-[rr:REMEMBERS]->(m)
          SET rr.is_system = true
        )
        WITH m
        CALL {
          WITH m
          UNWIND $relatedNodeIds AS nid
          OPTIONAL MATCH (kn:GraphNode {publicId: nid, orgId: $orgId})
          FOREACH (_ IN CASE WHEN kn IS NULL THEN [] ELSE [1] END |
            MERGE (m)-[ra:ABOUT]->(kn)
            SET ra.is_system = true
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

/** A decayable AgentMemory projection, scoped to the active tenant. */
export interface DecayableMemory {
  id: string;
  weight: "low" | "high" | "critical";
  confidence: number;
  lastReinforcedAt: string | null;
  createdAt: string;
  nodeRef: string;
}

/**
 * List all decayable (non-critical, confidence > 0) AgentMemory nodes for the
 * active tenant scope. Returns plain typed objects — the raw neo4j-driver
 * records never leave this package, so callers (e.g. the decay-pass Inngest
 * function) get a fully typed projection with no `any` boundary.
 *
 * orgId/workspaceId are injected automatically by scopedSession() from the
 * active tenant scope.
 */
export async function listDecayableMemories(): Promise<DecayableMemory[]> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
        WHERE m.weight <> 'critical'
          AND coalesce(m.confidence, 1.0) > 0
        RETURN
          m.id            AS id,
          m.weight        AS weight,
          coalesce(m.confidence, 1.0)  AS confidence,
          toString(m.lastReinforcedAt) AS lastReinforcedAt,
          toString(m.createdAt)        AS createdAt,
          coalesce(m.nodeRef, '')      AS nodeRef
      `,
    );
    /* eslint-disable @typescript-eslint/no-unsafe-assignment -- neo4j-driver Record.get() is typed as `any`; shape is guaranteed by the Cypher projection above. */
    return result.records.map((r) => ({
      id: r.get("id"),
      weight: r.get("weight"),
      confidence: Number(r.get("confidence") ?? 1.0),
      lastReinforcedAt: r.get("lastReinforcedAt") ?? null,
      createdAt: r.get("createdAt"),
      nodeRef: r.get("nodeRef") ?? "",
    }));
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
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

// Shared RETURN projection so getMemoryById/updateMemory hand back exactly the
// MemoryListRow shape (and therefore the agentMemoryRecordSchema) that the
// list/recall surfaces use — one definition, no drift.
const MEMORY_RETURN = /* cypher */ `
  RETURN
    m.id AS id,
    coalesce(m.publicId, m.id) AS publicId,
    coalesce(m.nodeRef, '') AS nodeRef,
    m.weight AS weight,
    m.kind AS kind,
    m.lesson AS lesson,
    m.source AS source,
    coalesce(m.confidence, 1.0) AS confidence,
    toString(m.createdAt) AS createdAt,
    toString(m.lastReinforcedAt) AS lastReinforcedAt
`;

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- neo4j-driver Record.get() is typed as `any`; shape is guaranteed by MEMORY_RETURN above. */
function rowFromRecord(r: { get: (k: string) => unknown }): MemoryListRow {
  return {
    id: r.get("id") as string,
    publicId: r.get("publicId") as string,
    nodeRef: (r.get("nodeRef") as string) ?? "",
    weight: r.get("weight") as MemoryListRow["weight"],
    kind: r.get("kind") as string,
    lesson: r.get("lesson") as string,
    source: r.get("source") as string,
    confidence: Number(r.get("confidence") ?? 1.0),
    createdAt: r.get("createdAt") as string,
    lastReinforcedAt: (r.get("lastReinforcedAt") as string | null) ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

/**
 * Fetch a single AgentMemory by id, scoped to the active tenant. Returns null
 * when no node matches in this workspace. Backs `agent.memory.remember` (to
 * return the freshly-written record) and the CLI `memory show` view.
 *
 * orgId/workspaceId are injected automatically by scopedSession().
 */
export async function getMemoryById(memoryId: string): Promise<MemoryListRow | null> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        ${MEMORY_RETURN}
      `,
      { memoryId },
    );
    const rec = result.records[0];
    return rec ? rowFromRecord(rec) : null;
  } finally {
    await s.close();
  }
}

export interface UpdateMemoryArgs {
  memoryId: string;
  lesson?: string;
  weight?: "low" | "high" | "critical";
  kind?: string;
  source?: string;
  confidence?: number;
  /** New embedding — pass only when the lesson changed and was re-embedded. */
  embedding?: number[];
}

/**
 * Edit an AgentMemory in place. Every field is optional: a null param leaves the
 * stored value untouched via `coalesce`, so callers patch only what changed.
 * `displayName` tracks the lesson, and `embedding` is replaced only when a new
 * one is supplied (the lesson changed). Returns the updated row, or null when no
 * node matched in this workspace.
 *
 * orgId/workspaceId are injected automatically by scopedSession().
 */
export async function updateMemory(
  args: UpdateMemoryArgs,
): Promise<MemoryListRow | null> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        SET
          m.lesson = coalesce($lesson, m.lesson),
          m.displayName = CASE WHEN $lesson IS NULL
                            THEN coalesce(m.displayName, left(m.lesson, 200))
                            ELSE left($lesson, 200) END,
          m.weight = coalesce($weight, m.weight),
          m.kind = coalesce($kind, m.kind),
          m.source = coalesce($source, m.source),
          m.confidence = coalesce($confidence, m.confidence),
          m.embedding = CASE WHEN $embedding IS NULL THEN m.embedding ELSE $embedding END,
          m.updatedAt = datetime()
        ${MEMORY_RETURN}
      `,
      {
        memoryId: args.memoryId,
        lesson: args.lesson ?? null,
        weight: args.weight ?? null,
        kind: args.kind ?? null,
        source: args.source ?? null,
        // 0 is a meaningful confidence; only undefined means "leave unchanged".
        confidence: args.confidence ?? null,
        embedding: args.embedding ?? null,
      },
    );
    const rec = result.records[0];
    return rec ? rowFromRecord(rec) : null;
  } finally {
    await s.close();
  }
}

/**
 * Hard-delete an AgentMemory and all its edges (`DETACH DELETE`), scoped to the
 * active tenant. Returns true when a node matched and was removed, false when
 * none matched. Binding the id before the delete lets us report whether anything
 * was actually deleted (a plain `count(m)` after DETACH DELETE is unreliable
 * across driver versions).
 *
 * orgId/workspaceId are injected automatically by scopedSession().
 */
export async function deleteMemory(args: { memoryId: string }): Promise<boolean> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        WITH m, m.id AS deletedId
        DETACH DELETE m
        RETURN deletedId
      `,
      { memoryId: args.memoryId },
    );
    return result.records.length > 0;
  } finally {
    await s.close();
  }
}
