import { scopedSession } from "@oxagen/ontology";

/**
 * Two-axis memory repository (docs/specs/two-axis-memory). All Cypher that reads
 * or writes the memory graph lives here. Memories are stored under the
 * `:AgentMemory` label (the schema's logical `:Memory`), with two independent
 * axes — memory_class (OBSERVATION→RULE→FACT) and memory_kind (content domain) —
 * and two independent weights — confidence_score (0-100, auto-decays) and
 * enforcement_score (1-100, policy). Citation/Promotion/Evidence nodes back the
 * confidence ladder.
 *
 * orgId/workspaceId are injected automatically by scopedSession() from the
 * active tenant scope — never thread them through function args.
 */

export type MemoryClass = "OBSERVATION" | "RULE" | "FACT";
export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "RETRACTED" | "ARCHIVED";
export type ActorKind = "AGENT" | "USER" | "SYSTEM";
export type Influence = "DECISIVE" | "CONTRIBUTING" | "CONSIDERED" | "IGNORED";
export type Compliance = "COMPLIED" | "DISCRETION" | "VIOLATION" | "NA";
export type EvidenceSourceKind =
  | "CITATION"
  | "HUMAN_CONFIRM"
  | "CODE_SCAN"
  | "AGENT_JUDGE"
  | "REPEAT_OBSERVATION";

/** The canonical memory projection — mirrors `agentMemoryRecordSchema`. */
export interface MemoryRecord {
  id: string;
  publicId: string;
  nodeRef: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  lesson: string;
  source: string;
  confidenceScore: number;
  enforcementScore: number | null;
  status: MemoryStatus;
  subjectHint: string;
  halfLifeDays: number;
  decayFloor: number;
  lastEvidenceAt: string | null;
  citationCount: number;
  influenceCount: number;
  violationCount: number;
  createdByKind: ActorKind;
  createdById: string | null;
  confirmedByKind: ActorKind | null;
  confirmedById: string | null;
  createdAt: string;
  lastReinforcedAt: string | null;
}

/** Recall adds the vector similarity score to the base record. */
export interface MemoryRow extends MemoryRecord {
  score: number;
}

/** Alias kept for call sites that browse the list surface. */
export type MemoryListRow = MemoryRecord;

// Shared RETURN projection. `coalesce` guards nodes that predate the two-axis
// backfill so a laggy migration never yields nulls the contract rejects.
const MEMORY_RETURN = /* cypher */ `
  RETURN
    m.id AS id,
    coalesce(m.publicId, m.id) AS publicId,
    coalesce(m.nodeRef, '') AS nodeRef,
    coalesce(m.memory_class, 'OBSERVATION') AS memoryClass,
    coalesce(m.memory_kind, m.kind, 'constraint') AS memoryKind,
    m.lesson AS lesson,
    coalesce(m.source, 'system') AS source,
    coalesce(m.confidence_score, coalesce(m.confidence, 1.0) * 100.0) AS confidenceScore,
    m.enforcement_score AS enforcementScore,
    coalesce(m.status, 'ACTIVE') AS status,
    coalesce(m.subject_hint, m.nodeRef, '') AS subjectHint,
    coalesce(m.half_life_days, 30.0) AS halfLifeDays,
    coalesce(m.decay_floor, 5.0) AS decayFloor,
    toString(coalesce(m.last_evidence_at, m.lastReinforcedAt, m.createdAt)) AS lastEvidenceAt,
    coalesce(m.citation_count, 0) AS citationCount,
    coalesce(m.influence_count, 0) AS influenceCount,
    coalesce(m.violation_count, 0) AS violationCount,
    coalesce(m.created_by_kind, 'SYSTEM') AS createdByKind,
    m.created_by_id AS createdById,
    m.confirmed_by_kind AS confirmedByKind,
    m.confirmed_by_id AS confirmedById,
    toString(m.createdAt) AS createdAt,
    toString(coalesce(m.lastReinforcedAt, m.last_evidence_at)) AS lastReinforcedAt
`;

function rowFromRecord(r: { get: (k: string) => unknown }): MemoryRecord {
  return {
    id: r.get("id") as string,
    publicId: r.get("publicId") as string,
    nodeRef: (r.get("nodeRef") as string) ?? "",
    memoryClass: r.get("memoryClass") as MemoryClass,
    memoryKind: r.get("memoryKind") as string,
    lesson: r.get("lesson") as string,
    source: r.get("source") as string,
    confidenceScore: Number(r.get("confidenceScore") ?? 100),
    enforcementScore:
      r.get("enforcementScore") == null ? null : Number(r.get("enforcementScore")),
    status: r.get("status") as MemoryStatus,
    subjectHint: (r.get("subjectHint") as string) ?? "",
    halfLifeDays: Number(r.get("halfLifeDays") ?? 30),
    decayFloor: Number(r.get("decayFloor") ?? 5),
    lastEvidenceAt: (r.get("lastEvidenceAt") as string | null) ?? null,
    citationCount: Number(r.get("citationCount") ?? 0),
    influenceCount: Number(r.get("influenceCount") ?? 0),
    violationCount: Number(r.get("violationCount") ?? 0),
    createdByKind: r.get("createdByKind") as ActorKind,
    createdById: (r.get("createdById") as string | null) ?? null,
    confirmedByKind: (r.get("confirmedByKind") as ActorKind | null) ?? null,
    confirmedById: (r.get("confirmedById") as string | null) ?? null,
    createdAt: r.get("createdAt") as string,
    lastReinforcedAt: (r.get("lastReinforcedAt") as string | null) ?? null,
  };
}

// Default per-class half-lives (days). FACT is effectively immortal.
const HALF_LIFE_BY_CLASS: Record<MemoryClass, number> = {
  OBSERVATION: 30,
  RULE: 90,
  FACT: 36500,
};

/**
 * Vector recall over ACTIVE :AgentMemory. Filters by tenant + status + optional
 * class/enforcement at query time, then gates on the confidence threshold
 * (policy stays 0-1, so we compare confidence_score/100).
 */
export async function recallMemories(args: {
  embedding: number[];
  limit: number;
  nodeRef?: string;
  memoryClass?: MemoryClass;
  minEnforcement?: number;
  recallThreshold?: number;
}): Promise<MemoryRow[]> {
  const s = scopedSession();
  try {
    const recallThreshold = args.recallThreshold ?? 0;
    const result = await s.run(
      /* cypher */ `
        CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
        YIELD node AS m, score
        WHERE m.orgId = $orgId
          AND m.workspaceId = $workspaceId
          AND coalesce(m.status, 'ACTIVE') = 'ACTIVE'
          AND ($nodeRef IS NULL OR m.nodeRef = $nodeRef)
          AND ($memoryClass IS NULL OR coalesce(m.memory_class, 'OBSERVATION') = $memoryClass)
          AND ($minEnforcement IS NULL OR coalesce(m.enforcement_score, 0) >= $minEnforcement)
          AND (coalesce(m.confidence_score, coalesce(m.confidence, 1.0) * 100.0) / 100.0) >= $recallThreshold
        WITH m, score
        ORDER BY score DESC
        LIMIT $limit
        ${MEMORY_RETURN}, score AS score
      `,
      {
        embedding: args.embedding,
        nodeRef: args.nodeRef ?? null,
        memoryClass: args.memoryClass ?? null,
        minEnforcement: args.minEnforcement ?? null,
        limit: BigInt(args.limit),
        recallThreshold,
      },
    );
    return result.records.map((r) => ({
      ...rowFromRecord(r),
      score: Number(r.get("score")),
    }));
  } finally {
    await s.close();
  }
}

/**
 * Browse ACTIVE :AgentMemory nodes for the active tenant, newest first, with
 * optional class/kind/enforcement/node filters. Returns the page plus the
 * unpaged `total`.
 */
export async function listMemories(args: {
  limit: number;
  offset: number;
  nodeRef?: string;
  memoryClass?: MemoryClass;
  memoryKind?: string;
  minEnforcement?: number;
  minCitations?: number;
  sort?: "createdAt" | "citationCount";
  sortDir?: "asc" | "desc";
}): Promise<{ memories: MemoryListRow[]; total: number }> {
  const s = scopedSession();
  const where = /* cypher */ `
    WHERE coalesce(m.status, 'ACTIVE') = 'ACTIVE'
      AND ($nodeRef IS NULL OR m.nodeRef = $nodeRef)
      AND ($memoryClass IS NULL OR coalesce(m.memory_class, 'OBSERVATION') = $memoryClass)
      AND ($memoryKind IS NULL OR coalesce(m.memory_kind, m.kind) = $memoryKind)
      AND ($minEnforcement IS NULL OR coalesce(m.enforcement_score, 0) >= $minEnforcement)
      AND ($minCitations IS NULL OR coalesce(m.citation_count, 0) >= $minCitations)
  `;
  // ORDER BY cannot be parameterised in Cypher, so build it from a fixed
  // whitelist of (axis, direction) pairs — never interpolate caller strings.
  const dir = args.sortDir === "asc" ? "ASC" : "DESC";
  const orderBy =
    args.sort === "citationCount"
      ? // Tie-break by recency so equal citation counts stay deterministic.
        `coalesce(m.citation_count, 0) ${dir}, m.createdAt DESC`
      : `m.createdAt ${dir}`;
  const params = {
    nodeRef: args.nodeRef ?? null,
    memoryClass: args.memoryClass ?? null,
    memoryKind: args.memoryKind ?? null,
    minEnforcement: args.minEnforcement ?? null,
    minCitations: args.minCitations ?? null,
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
        WITH m ORDER BY ${orderBy} SKIP $offset LIMIT $limit
        ${MEMORY_RETURN}
      `,
      { ...params, offset: BigInt(args.offset), limit: BigInt(args.limit) },
    );
    return { memories: pageResult.records.map(rowFromRecord), total };
  } finally {
    await s.close();
  }
}

export interface WriteMemoryArgs {
  nodeRef: string;
  embedding: number[];
  memoryClass: MemoryClass;
  memoryKind: string;
  enforcementScore?: number | null;
  lesson: string;
  source: string;
  createdByKind?: ActorKind;
  createdById?: string | null;
  confirmedByKind?: ActorKind | null;
  confirmedById?: string | null;
  halfLifeDays?: number;
  decayFloor?: number;
  /** IDs of KnowledgeNode entities this memory is about — creates :ABOUT edges. */
  relatedNodeIds?: string[];
}

/**
 * Upsert a memory. MERGE on (orgId, workspaceId, nodeRef, lesson) so identical
 * writes from repeated reflection don't accumulate duplicates. A fresh write
 * starts at confidence_score 100, status ACTIVE, zeroed counters, and
 * last_evidence_at = now.
 */
export async function writeMemory(
  args: WriteMemoryArgs,
): Promise<{ memoryId: string; edgesCreated: number }> {
  const s = scopedSession();
  const halfLifeDays = args.halfLifeDays ?? HALF_LIFE_BY_CLASS[args.memoryClass];
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
          m.memory_class = $memoryClass,
          m.memory_kind = $memoryKind,
          m.enforcement_score = $enforcementScore,
          m.source = $source,
          m.embedding = $embedding,
          m.confidence_score = 100.0,
          m.half_life_days = $halfLifeDays,
          m.decay_floor = $decayFloor,
          m.status = 'ACTIVE',
          m.subject_hint = $nodeRef,
          m.citation_count = 0,
          m.influence_count = 0,
          m.violation_count = 0,
          m.created_by_kind = $createdByKind,
          m.created_by_id = $createdById,
          m.confirmed_by_kind = $confirmedByKind,
          m.confirmed_by_id = $confirmedById,
          m.last_evidence_at = datetime(),
          m.lastReinforcedAt = datetime(),
          m.createdAt = datetime()
        ON MATCH SET
          m:GraphNode,
          m.is_system = true,
          m.label = 'AgentMemory',
          m.displayName = left($lesson, 200),
          m.publicId = coalesce(m.publicId, randomUUID()),
          m.memory_class = $memoryClass,
          m.memory_kind = $memoryKind,
          m.enforcement_score = $enforcementScore,
          m.source = $source,
          m.embedding = $embedding,
          m.half_life_days = $halfLifeDays,
          m.decay_floor = coalesce(m.decay_floor, $decayFloor),
          m.status = coalesce(m.status, 'ACTIVE'),
          m.confidence_score = coalesce(m.confidence_score, 100.0),
          m.confirmed_by_kind = coalesce($confirmedByKind, m.confirmed_by_kind),
          m.confirmed_by_id = coalesce($confirmedById, m.confirmed_by_id),
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
            SET ra.is_system = true, ra.role = coalesce(ra.role, 'CONTEXT'), ra.weight = coalesce(ra.weight, 0.5)
          )
          RETURN count(kn) AS edgesCreated
        }
        RETURN m.id AS id, edgesCreated
      `,
      {
        nodeRef: args.nodeRef,
        lesson: args.lesson,
        memoryClass: args.memoryClass,
        memoryKind: args.memoryKind,
        enforcementScore: args.enforcementScore ?? null,
        source: args.source,
        embedding: args.embedding,
        halfLifeDays,
        decayFloor: args.decayFloor ?? 5.0,
        createdByKind: args.createdByKind ?? "AGENT",
        createdById: args.createdById ?? null,
        confirmedByKind: args.confirmedByKind ?? null,
        confirmedById: args.confirmedById ?? null,
        relatedNodeIds: args.relatedNodeIds ?? [],
      },
    );
    const id = result.records[0]?.get("id") as string | undefined;
    if (!id) {
      throw new Error("writeMemory: MERGE returned no record");
    }
    const edgesCreated = Number(result.records[0]?.get("edgesCreated") ?? 0);
    return { memoryId: id, edgesCreated };
  } finally {
    await s.close();
  }
}

export interface UpdateMemoryArgs {
  memoryId: string;
  lesson?: string;
  memoryKind?: string;
  source?: string;
  confidenceScore?: number;
  enforcementScore?: number | null;
  status?: MemoryStatus;
  /** New embedding — pass only when the lesson changed and was re-embedded. */
  embedding?: number[];
}

/**
 * Edit a memory in place. Every field is optional; a null param leaves the
 * stored value untouched via `coalesce`. Class changes go through
 * `promoteMemory` (auditable + invariant-checked), not this function. Returns
 * the updated row, or null when no node matched in this workspace.
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
          m.memory_kind = coalesce($memoryKind, m.memory_kind),
          m.source = coalesce($source, m.source),
          m.confidence_score = coalesce($confidenceScore, m.confidence_score),
          m.enforcement_score = CASE WHEN $enforcementScore IS NULL THEN m.enforcement_score ELSE $enforcementScore END,
          m.status = coalesce($status, m.status),
          m.embedding = CASE WHEN $embedding IS NULL THEN m.embedding ELSE $embedding END,
          m.updatedAt = datetime()
        ${MEMORY_RETURN}
      `,
      {
        memoryId: args.memoryId,
        lesson: args.lesson ?? null,
        memoryKind: args.memoryKind ?? null,
        source: args.source ?? null,
        confidenceScore: args.confidenceScore ?? null,
        enforcementScore: args.enforcementScore ?? null,
        status: args.status ?? null,
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
 * Fetch a single :AgentMemory by id, scoped to the active tenant. Returns null
 * when no node matches in this workspace.
 */
export async function getMemoryById(
  memoryId: string,
): Promise<MemoryListRow | null> {
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

/**
 * Hard-delete a memory and all its edges (`DETACH DELETE`), scoped to the active
 * tenant. Returns true when a node matched and was removed.
 */
export async function deleteMemory(args: {
  memoryId: string;
}): Promise<boolean> {
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

// ── Decay / recovery ────────────────────────────────────────────────────────

/** A decayable memory projection, scoped to the active tenant. */
export interface DecayableMemory {
  id: string;
  confidenceScore: number;
  halfLifeDays: number;
  decayFloor: number;
  lastEvidenceAt: string | null;
  createdAt: string;
  nodeRef: string;
}

/**
 * List all decayable (ACTIVE, non-FACT, confidence above floor) memories for the
 * active tenant. The decay-pass Inngest function computes the new confidence and
 * calls `applyDecayToMemory`.
 */
export async function listDecayableMemories(): Promise<DecayableMemory[]> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
        WHERE coalesce(m.status, 'ACTIVE') = 'ACTIVE'
          AND coalesce(m.memory_class, 'OBSERVATION') <> 'FACT'
          AND coalesce(m.confidence_score, coalesce(m.confidence, 1.0) * 100.0) > coalesce(m.decay_floor, 5.0)
        RETURN
          m.id AS id,
          coalesce(m.confidence_score, coalesce(m.confidence, 1.0) * 100.0) AS confidenceScore,
          coalesce(m.half_life_days, 30.0) AS halfLifeDays,
          coalesce(m.decay_floor, 5.0) AS decayFloor,
          toString(coalesce(m.last_evidence_at, m.lastReinforcedAt, m.createdAt)) AS lastEvidenceAt,
          toString(m.createdAt) AS createdAt,
          coalesce(m.nodeRef, '') AS nodeRef
      `,
    );
    return result.records.map((r) => ({
      id: r.get("id") as string,
      confidenceScore: Number(r.get("confidenceScore") ?? 100),
      halfLifeDays: Number(r.get("halfLifeDays") ?? 30),
      decayFloor: Number(r.get("decayFloor") ?? 5),
      lastEvidenceAt: (r.get("lastEvidenceAt") as string | null) ?? null,
      createdAt: r.get("createdAt") as string,
      nodeRef: (r.get("nodeRef") as string) ?? "",
    }));
  } finally {
    await s.close();
  }
}

/**
 * Set a memory's confidence_score to `newConfidence` (the decayed value). The
 * decay-pass function computes it via
 *   floor + (conf - floor) * 0.5 ^ (daysSince / halfLifeDays).
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
        SET m.confidence_score = $newConfidence
      `,
      { memoryId: args.memoryId, newConfidence: args.newConfidence },
    );
  } finally {
    await s.close();
  }
}

/**
 * Recover confidence by adding `amount` (0-100), capped at 100, and refresh the
 * decay clock. `reinforceMemory` is a thin recovery without an Evidence node;
 * `attachEvidence` records provenance too. Returns the new confidence.
 */
export async function reinforceMemory(args: {
  memoryId: string;
  reinforcementAmount: number;
}): Promise<{ confidenceScore: number }> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        SET m.confidence_score = CASE WHEN coalesce(m.confidence_score, 100.0) + $amount > 100.0
                            THEN 100.0
                            ELSE coalesce(m.confidence_score, 100.0) + $amount END,
            m.last_evidence_at = datetime(),
            m.lastReinforcedAt = datetime()
        RETURN m.confidence_score AS confidenceScore
      `,
      { memoryId: args.memoryId, amount: args.reinforcementAmount },
    );
    return {
      confidenceScore: Number(
        result.records[0]?.get("confidenceScore") ?? 100,
      ),
    };
  } finally {
    await s.close();
  }
}

// ── Promotion (OBSERVATION → RULE / FACT) ───────────────────────────────────

export interface PromoteMemoryArgs {
  memoryId: string;
  toClass: Exclude<MemoryClass, "OBSERVATION">;
  enforcementScore: number | null;
  promotedByKind: ActorKind;
  promotedById: string | null;
  rationale: string;
  confirmedById?: string | null;
  basedOnEvidenceIds?: string[];
}

/**
 * Promote a memory to RULE or FACT, recording an auditable :Promotion event
 * (schema §4). FACT forces enforcement 100 and confirmed_by_kind=USER — the
 * caller must have validated this (see `assertMemoryClassInvariants`). Returns
 * the updated record, or null when no node matched.
 */
export async function promoteMemory(
  args: PromoteMemoryArgs,
): Promise<MemoryListRow | null> {
  const s = scopedSession();
  const enforcement =
    args.toClass === "FACT" ? 100 : args.enforcementScore;
  const confirmedByKind = args.toClass === "FACT" ? "USER" : null;
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        CREATE (p:Promotion {
          id: randomUUID(),
          orgId: $orgId,
          workspaceId: $workspaceId,
          from_class: coalesce(m.memory_class, 'OBSERVATION'),
          to_class: $toClass,
          promoted_by_kind: $promotedByKind,
          promoted_by_id: $promotedById,
          enforcement_score_set: $enforcement,
          rationale: $rationale,
          created_at: datetime()
        })
        CREATE (p)-[:PROMOTED]->(m)
        WITH m, p
        CALL {
          WITH p
          UNWIND $basedOnEvidenceIds AS eid
          OPTIONAL MATCH (ev:Evidence {id: eid, orgId: $orgId})
          FOREACH (_ IN CASE WHEN ev IS NULL THEN [] ELSE [1] END |
            MERGE (p)-[:BASED_ON]->(ev)
          )
          RETURN count(*) AS _based
        }
        SET m.memory_class = $toClass,
            m.enforcement_score = $enforcement,
            m.confirmed_by_kind = coalesce($confirmedByKind, m.confirmed_by_kind),
            m.confirmed_by_id = coalesce($confirmedById, m.confirmed_by_id),
            m.updatedAt = datetime()
        ${MEMORY_RETURN}
      `,
      {
        memoryId: args.memoryId,
        toClass: args.toClass,
        enforcement,
        promotedByKind: args.promotedByKind,
        promotedById: args.promotedById,
        rationale: args.rationale,
        confirmedByKind,
        confirmedById: args.confirmedById ?? null,
        basedOnEvidenceIds: args.basedOnEvidenceIds ?? [],
      },
    );
    const rec = result.records[0];
    return rec ? rowFromRecord(rec) : null;
  } finally {
    await s.close();
  }
}

export interface PromotionCandidate {
  id: string;
  publicId: string;
  lesson: string;
  memoryKind: string;
  citationCount: number;
  influenceCount: number;
  confidenceScore: number;
}

/**
 * Top promotable OBSERVATIONs by citation pressure (schema §7c). Feeds the
 * "promote to rule/fact" UI.
 */
export async function listPromotionCandidates(args: {
  limit: number;
}): Promise<PromotionCandidate[]> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
        WHERE coalesce(m.memory_class, 'OBSERVATION') = 'OBSERVATION'
          AND coalesce(m.status, 'ACTIVE') = 'ACTIVE'
        RETURN
          m.id AS id,
          coalesce(m.publicId, m.id) AS publicId,
          m.lesson AS lesson,
          coalesce(m.memory_kind, m.kind, 'constraint') AS memoryKind,
          coalesce(m.citation_count, 0) AS citationCount,
          coalesce(m.influence_count, 0) AS influenceCount,
          coalesce(m.confidence_score, coalesce(m.confidence, 1.0) * 100.0) AS confidenceScore
        ORDER BY citationCount DESC, influenceCount DESC
        LIMIT $limit
      `,
      { limit: BigInt(args.limit) },
    );
    return result.records.map((r) => ({
      id: r.get("id") as string,
      publicId: r.get("publicId") as string,
      lesson: r.get("lesson") as string,
      memoryKind: r.get("memoryKind") as string,
      citationCount: Number(r.get("citationCount") ?? 0),
      influenceCount: Number(r.get("influenceCount") ?? 0),
      confidenceScore: Number(r.get("confidenceScore") ?? 100),
    }));
  } finally {
    await s.close();
  }
}

// ── Execution + Citation (the influence/compliance mechanism, schema §6) ─────

/**
 * MERGE an :Execution node by id so citations can attach to it. Idempotent — a
 * repeated run with the same executionRef updates task_summary/ended_at.
 */
export async function recordExecution(args: {
  executionRef: string;
  agentId?: string | null;
  runId?: string | null;
  taskSummary?: string | null;
}): Promise<{ executionId: string }> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MERGE (e:Execution {id: $executionRef, orgId: $orgId, workspaceId: $workspaceId})
        ON CREATE SET
          e.publicId = coalesce(e.publicId, randomUUID()),
          e:GraphNode,
          e.is_system = true,
          e.label = 'Execution',
          e.agent_id = $agentId,
          e.run_id = $runId,
          e.task_summary = $taskSummary,
          e.started_at = datetime()
        ON MATCH SET
          e.task_summary = coalesce($taskSummary, e.task_summary),
          e.ended_at = datetime()
        RETURN e.id AS id
      `,
      {
        executionRef: args.executionRef,
        agentId: args.agentId ?? null,
        runId: args.runId ?? null,
        taskSummary: args.taskSummary ?? null,
      },
    );
    return { executionId: result.records[0]?.get("id") as string };
  } finally {
    await s.close();
  }
}

export interface RecordCitationArgs {
  executionId: string;
  memoryId: string;
  influence: Influence;
  compliance: Compliance;
  enforcementAtCite: number | null;
  confidenceAtCite: number;
  expectedValue?: string | null;
  observedValue?: string | null;
  agentRationale?: string | null;
}

/**
 * Record a :Citation of a memory within an execution and run counter maintenance
 * (schema §6/§7f): citation_count++, influence_count++ when DECISIVE/CONTRIBUTING,
 * violation_count++ when compliance=VIOLATION. Returns the created citation id.
 */
export async function recordCitation(
  args: RecordCitationArgs,
): Promise<{ citationId: string } | null> {
  const s = scopedSession();
  const isInfluential =
    args.influence === "DECISIVE" || args.influence === "CONTRIBUTING";
  const isViolation = args.compliance === "VIOLATION";
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (e:Execution {id: $executionId, orgId: $orgId, workspaceId: $workspaceId})
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        CREATE (c:Citation {
          id: randomUUID(),
          orgId: $orgId,
          workspaceId: $workspaceId,
          retrieved_at: datetime(),
          influence: $influence,
          compliance: $compliance,
          enforcement_at_cite: $enforcementAtCite,
          confidence_at_cite: $confidenceAtCite,
          expected_value: $expectedValue,
          observed_value: $observedValue,
          agent_rationale: $agentRationale
        })
        CREATE (e)-[:CITED]->(c)
        CREATE (c)-[:OF]->(m)
        SET m.citation_count = coalesce(m.citation_count, 0) + 1,
            m.influence_count = coalesce(m.influence_count, 0) + (CASE WHEN $isInfluential THEN 1 ELSE 0 END),
            m.violation_count = coalesce(m.violation_count, 0) + (CASE WHEN $isViolation THEN 1 ELSE 0 END),
            m.updatedAt = datetime()
        RETURN c.id AS id
      `,
      {
        executionId: args.executionId,
        memoryId: args.memoryId,
        influence: args.influence,
        compliance: args.compliance,
        enforcementAtCite: args.enforcementAtCite ?? null,
        confidenceAtCite: args.confidenceAtCite,
        expectedValue: args.expectedValue ?? null,
        observedValue: args.observedValue ?? null,
        agentRationale: args.agentRationale ?? null,
        isInfluential,
        isViolation,
      },
    );
    const id = result.records[0]?.get("id") as string | undefined;
    return id ? { citationId: id } : null;
  } finally {
    await s.close();
  }
}

export interface ExecutionCitation {
  citationId: string;
  memoryId: string;
  lesson: string;
  influence: Influence;
  compliance: Compliance;
  enforcementAtCite: number | null;
  expectedValue: string | null;
  observedValue: string | null;
  agentRationale: string | null;
}

/**
 * List citations for an execution (schema §7d/§7e). Filter by compliance (e.g.
 * VIOLATION) and/or influence (e.g. DECISIVE/CONTRIBUTING).
 */
export async function listExecutionCitations(args: {
  executionId: string;
  compliance?: Compliance;
  influenceIn?: Influence[];
}): Promise<ExecutionCitation[]> {
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (e:Execution {id: $executionId, orgId: $orgId, workspaceId: $workspaceId})-[:CITED]->(c:Citation)-[:OF]->(m:AgentMemory)
        WHERE ($compliance IS NULL OR c.compliance = $compliance)
          AND ($influenceIn IS NULL OR c.influence IN $influenceIn)
        RETURN
          c.id AS citationId,
          m.id AS memoryId,
          m.lesson AS lesson,
          c.influence AS influence,
          c.compliance AS compliance,
          c.enforcement_at_cite AS enforcementAtCite,
          c.expected_value AS expectedValue,
          c.observed_value AS observedValue,
          c.agent_rationale AS agentRationale
        ORDER BY c.retrieved_at DESC
      `,
      {
        executionId: args.executionId,
        compliance: args.compliance ?? null,
        influenceIn: args.influenceIn ?? null,
      },
    );
    return result.records.map((r) => ({
      citationId: r.get("citationId") as string,
      memoryId: r.get("memoryId") as string,
      lesson: r.get("lesson") as string,
      influence: r.get("influence") as Influence,
      compliance: r.get("compliance") as Compliance,
      enforcementAtCite:
        r.get("enforcementAtCite") == null
          ? null
          : Number(r.get("enforcementAtCite")),
      expectedValue: (r.get("expectedValue") as string | null) ?? null,
      observedValue: (r.get("observedValue") as string | null) ?? null,
      agentRationale: (r.get("agentRationale") as string | null) ?? null,
    }));
  } finally {
    await s.close();
  }
}

// ── Evidence (confidence recovery / refutation, schema §5/§7b) ──────────────

export interface AttachEvidenceArgs {
  memoryId: string;
  sourceKind: EvidenceSourceKind;
  /** 0-1 contribution; recovery adds strength*100 to confidence (refutes subtracts). */
  strength: number;
  detail?: string | null;
  refutes?: boolean;
}

/**
 * Attach an :Evidence node to a memory and adjust confidence (schema §5/§7b).
 * Supporting evidence pulls confidence up by strength*100 (capped 100) and
 * refreshes last_evidence_at; refuting evidence pulls it down (floored 0).
 * Returns the created evidence id and the new confidence.
 */
export async function attachEvidence(
  args: AttachEvidenceArgs,
): Promise<{ evidenceId: string; confidenceScore: number } | null> {
  const s = scopedSession();
  const delta = (args.refutes ? -1 : 1) * args.strength * 100;
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (m:AgentMemory {id: $memoryId, orgId: $orgId, workspaceId: $workspaceId})
        CREATE (ev:Evidence {
          id: randomUUID(),
          orgId: $orgId,
          workspaceId: $workspaceId,
          source_kind: $sourceKind,
          strength: $strength,
          detail: $detail,
          created_at: datetime()
        })
        CREATE (ev)-[${args.refutes ? ":REFUTES" : ":SUPPORTS"}]->(m)
        SET m.confidence_score = CASE
              WHEN coalesce(m.confidence_score, 100.0) + $delta > 100.0 THEN 100.0
              WHEN coalesce(m.confidence_score, 100.0) + $delta < 0.0 THEN 0.0
              ELSE coalesce(m.confidence_score, 100.0) + $delta END,
            m.last_evidence_at = datetime(),
            m.updatedAt = datetime()
        RETURN ev.id AS evidenceId, m.confidence_score AS confidenceScore
      `,
      {
        memoryId: args.memoryId,
        sourceKind: args.sourceKind,
        strength: args.strength,
        detail: args.detail ?? null,
        delta,
      },
    );
    const rec = result.records[0];
    if (!rec) return null;
    return {
      evidenceId: rec.get("evidenceId") as string,
      confidenceScore: Number(rec.get("confidenceScore") ?? 100),
    };
  } finally {
    await s.close();
  }
}
