import { describe, expect, it, vi, beforeEach } from "vitest";
import { withTestScope } from "@oxagen/tenancy/testing";

const sessionRun = vi.fn();
const sessionClose = vi.fn(async () => undefined);

vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: sessionRun, close: sessionClose }),
  // Real over-sampling math so the emitted $k reflects production behaviour.
  oversampledLimit: (limit: number, factor = 3, cap = 500) => {
    const base = Math.trunc(limit);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const f = Number.isFinite(factor) && factor >= 1 ? Math.trunc(factor) : 1;
    return Math.min(base * f, Math.max(base, Math.trunc(cap)));
  },
}));

import {
  recallMemories,
  writeMemory,
  reinforceMemory,
  applyDecayToMemory,
  listMemories,
  promoteMemory,
  demoteMemory,
  dismissPromotion,
  readCitationStats,
  MemoryDemotionDirectionError,
  listPromotionCandidates,
  recordExecution,
  recordCitation,
  listExecutionCitations,
  attachEvidence,
} from "./neo4j";

function fakeRecord(map: Record<string, unknown>) {
  return { get: (k: string) => map[k] };
}

describe("recallMemories", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("queries the vector index with tenant + class/enforcement filters", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          publicId: "pub_1",
          nodeRef: "Function:foo",
          memoryClass: "RULE",
          memoryKind: "constraint",
          lesson: "watch out",
          source: "feature",
          confidenceScore: 92,
          enforcementScore: 80,
          status: "ACTIVE",
          subjectHint: "Function:foo",
          halfLifeDays: 90,
          decayFloor: 5,
          lastEvidenceAt: "2026-05-28T00:00:00Z",
          citationCount: 0,
          influenceCount: 0,
          violationCount: 0,
          createdByKind: "AGENT",
          createdById: "feature",
          confirmedByKind: null,
          confirmedById: null,
          createdAt: "2026-05-28T00:00:00Z",
          lastReinforcedAt: null,
          score: 0.92,
        }),
      ],
    });
    const rows = await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        memoryClass: "RULE",
        minEnforcement: 50,
        limit: 10,
      }),
    );
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("memory_embedding_index");
    expect(cypher).toContain("m.orgId = $orgId");
    expect(cypher).toContain("workspaceId");
    expect(cypher).toContain("$memoryClass");
    expect(cypher).toContain("$minEnforcement");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    // orgId/workspaceId are injected by scopedSession (real impl), not threaded
    // through the function args; the mock here bypasses injection, so params
    // does not contain them — that is the correct test surface for this layer.
    expect(params.orgId).toBeUndefined();
    expect(params.workspaceId).toBeUndefined();
    expect(params.memoryClass).toBe("RULE");
    expect(params.minEnforcement).toBe(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("m_1");
    expect(rows[0]!.memoryClass).toBe("RULE");
    expect(rows[0]!.enforcementScore).toBe(80);
    expect(rows[0]!.score).toBe(0.92);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("leaves memoryClass/minEnforcement null when omitted", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        limit: 5,
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryClass).toBeNull();
    expect(params.minEnforcement).toBeNull();
  });
});

describe("recallMemories — recallThreshold filtering", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("passes recallThreshold to the Cypher query params", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        limit: 10,
        recallThreshold: 0.1,
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recallThreshold).toBe(0.1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("$recallThreshold");
    // The confidence gate compares confidence_score/100 against the threshold.
    expect(cypher).toContain("confidence_score");
  });

  it("defaults recallThreshold to 0 when not supplied", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        limit: 5,
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recallThreshold).toBe(0);
  });
});

describe("ANN tenant-filter over-sampling", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("recallMemories over-fetches the index by 3x but trims to the requested limit", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        limit: 10,
      }),
    );
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    // The index is queried with the over-sampled $k, not the raw limit.
    expect(cypher).toContain(
      "db.index.vector.queryNodes('memory_embedding_index', $k",
    );
    // The final result set is trimmed back to the requested limit after filtering.
    expect(cypher).toContain("LIMIT $limit");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.k).toBe(BigInt(30)); // 10 x 3
    expect(params.limit).toBe(BigInt(10));
  });
});

// Linear OXA-1929 — ANN tenant-filter oversampling (silent recall degradation).
//
// `db.index.vector.queryNodes` returns the GLOBAL top-k by similarity; the
// tenant predicate (m.orgId = $orgId) is applied AFTER that call in the WHERE
// clause. As other tenants accumulate more/higher-scoring graph volume, a
// naive query (k === limit) can be entirely crowded out for the active
// tenant — recall silently shrinks to zero with no error. These tests seed a
// synthetic global ranking that reproduces exactly that crowd-out and assert
// the shipped implementation (oversampledLimit under the hood) still
// recovers the full requested K for the target tenant. The mock's
// `sessionRun` implementation below mirrors what Neo4j actually executes:
// slice the global pool to the emitted `$k`, THEN filter to the target
// tenant, THEN trim to `$limit` — so this test fails if `recallMemories` /
// tenant-aware retrieval ever regresses to requesting `k = limit` again.
describe("multi-tenant recall regression (OXA-1929)", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  function seedMemoryRow(orgId: string, score: number, i: number) {
    return {
      orgId,
      score,
      record: fakeRecord({
        id: `m_${orgId}_${i}`,
        publicId: `pub_${orgId}_${i}`,
        nodeRef: "",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: `lesson ${i}`,
        source: "test",
        confidenceScore: 100,
        enforcementScore: null,
        status: "ACTIVE",
        subjectHint: "",
        halfLifeDays: 30,
        decayFloor: 5,
        lastEvidenceAt: null,
        citationCount: 0,
        influenceCount: 0,
        violationCount: 0,
        createdByKind: "AGENT",
        createdById: null,
        confirmedByKind: null,
        confirmedById: null,
        createdAt: "2026-01-01T00:00:00Z",
        lastReinforcedAt: null,
        score,
      }),
    };
  }

  it("recallMemories returns the full requested K for the target tenant even though other tenants dominate the global top-K", async () => {
    const limit = 10;
    // Global ANN ranking (already sorted DESC by score, as Neo4j returns it):
    //   ranks 0-19  → 20 higher-scoring memories from a noisy OTHER tenant
    //   ranks 20-49 → 30 lower-scoring memories from the TARGET tenant
    // A naive k=limit=10 query never reaches past rank 9, so the target
    // tenant would get zero results. oversampledLimit(10) = 30, which reaches
    // rank 29 and surfaces the first 10 target-tenant rows.
    const globalPool = [
      ...Array.from({ length: 20 }, (_, i) =>
        seedMemoryRow("org-noise", 1 - i * 0.001, i),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        seedMemoryRow("org-target", 0.5 - i * 0.001, i),
      ),
    ];

    // Sanity check the scenario is a genuine regression case: an unfixed
    // k === limit query against this exact pool starves the target tenant.
    expect(
      globalPool.slice(0, limit).filter((r) => r.orgId === "org-target"),
    ).toHaveLength(0);

    sessionRun.mockImplementation(async (_cypher: unknown, params: unknown) => {
      const k = Number((params as Record<string, unknown>).k as bigint);
      const topK = globalPool.slice(0, k);
      const tenantFiltered = topK.filter((r) => r.orgId === "org-target");
      const trimmed = tenantFiltered.slice(0, limit);
      return { records: trimmed.map((r) => r.record) };
    });

    const rows = await withTestScope(() =>
      recallMemories({ embedding: new Array<number>(1536).fill(0.1), limit }),
    );

    expect(rows).toHaveLength(limit);
  });
});

describe("writeMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("MERGEs on AgentMemory and returns the memory id", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_new", edgesCreated: 0 })],
    });
    const res = await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:foo",
        embedding: new Array<number>(1536).fill(0.2),
        memoryClass: "RULE",
        memoryKind: "constraint",
        enforcementScore: 80,
        lesson: "be careful",
        source: "feature",
      }),
    );
    expect(res.memoryId).toBe("m_new");
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    // Cypher must contain MERGE key with orgId (guard) and nodeRef
    expect(cypher).toContain("MERGE (m:AgentMemory {");
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("nodeRef: $nodeRef");
    // The optional REMEMBERS source match must be tenant-scoped so a
    // user-supplied nodeRef can never reach another tenant's node.
    expect(cypher).toContain(
      "OPTIONAL MATCH (target { id: $nodeRef, orgId: $orgId })",
    );
    // The edge-count must live in a CALL subquery so an empty relatedNodeIds
    // list (UNWIND []) does not collapse the outer m row to zero records.
    expect(cypher).toContain("CALL {");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.lesson).toBe("be careful");
    expect(params.memoryClass).toBe("RULE");
    expect(params.memoryKind).toBe("constraint");
    expect(params.enforcementScore).toBe(80);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("defaults half-life by class when halfLifeDays is not supplied", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_obs", edgesCreated: 0 })],
    });
    await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:foo",
        embedding: new Array<number>(1536).fill(0.2),
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "an observation",
        source: "feature",
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.halfLifeDays).toBe(30);
  });

  it("returns the memory id even when relatedNodeIds is empty", async () => {
    // Regression: the previous UNWIND-then-aggregate shape returned zero rows
    // when relatedNodeIds was [], yielding memoryId === undefined. The CALL
    // subquery preserves the m row, so the id is always returned.
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_empty", edgesCreated: 0 })],
    });
    const res = await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:foo",
        embedding: new Array<number>(1536).fill(0.2),
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "no related nodes",
        source: "feature",
      }),
    );
    expect(res.memoryId).toBe("m_empty");
    expect(res.edgesCreated).toBe(0);
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.relatedNodeIds).toEqual([]);
  });

  it("throws when the MERGE returns no record", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await expect(
      withTestScope(() =>
        writeMemory({
          nodeRef: "Function:foo",
          embedding: new Array<number>(1536).fill(0.2),
          memoryClass: "OBSERVATION",
          memoryKind: "constraint",
          lesson: "boom",
          source: "feature",
        }),
      ),
    ).rejects.toThrow("writeMemory: MERGE returned no record");
  });

  it("ON CREATE SET initialises confidence_score to exactly 100.0", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_new2", edgesCreated: 0 })],
    });
    await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:baz",
        embedding: new Array<number>(1536).fill(0.1),
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "confidence starts at 100",
        source: "feature",
      }),
    );
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("m.confidence_score = 100.0");
  });
});

describe("reinforceMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("returns capped confidence of 100.0 when increment would exceed cap", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ confidenceScore: 100.0 })],
    });
    const result = await withTestScope(() =>
      reinforceMemory({ memoryId: "m1", reinforcementAmount: 5 }),
    );
    expect(result.confidenceScore).toBe(100.0);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("m.confidence_score = CASE WHEN");
    expect(cypher).toContain("THEN 100.0");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("m1");
    expect(params.amount).toBe(5);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("returns the incremented confidence when well below cap", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ confidenceScore: 85 })],
    });
    const result = await withTestScope(() =>
      reinforceMemory({ memoryId: "m2", reinforcementAmount: 5 }),
    );
    expect(result.confidenceScore).toBeCloseTo(85, 5);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("applyDecayToMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("calls s.run with Cypher containing $newConfidence and passes the correct value", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      applyDecayToMemory({ memoryId: "m_decay", newConfidence: 42 }),
    );
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("$newConfidence");
    expect(cypher).toContain("m.confidence_score = $newConfidence");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("m_decay");
    expect(params.newConfidence).toBe(42);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session even when the query succeeds with zero records", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      applyDecayToMemory({ memoryId: "m_zero", newConfidence: 10 }),
    );
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("listMemories", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  function mockCountThenPage(
    total: number,
    pageRecords: ReturnType<typeof fakeRecord>[],
  ) {
    sessionRun
      .mockResolvedValueOnce({ records: [fakeRecord({ total })] })
      .mockResolvedValueOnce({ records: pageRecords });
  }

  it("returns the unpaged total and the projected page, newest first", async () => {
    mockCountThenPage(2, [
      fakeRecord({
        id: "m_1",
        publicId: "pub_1",
        nodeRef: "user:mac-anderson",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "the user's name is Mac Anderson",
        source: "feature",
        confidenceScore: 100,
        enforcementScore: null,
        status: "ACTIVE",
        subjectHint: "user:mac-anderson",
        halfLifeDays: 30,
        decayFloor: 5,
        lastEvidenceAt: "2026-06-27T00:00:00Z",
        citationCount: 0,
        influenceCount: 0,
        violationCount: 0,
        createdByKind: "AGENT",
        createdById: "feature",
        confirmedByKind: null,
        confirmedById: null,
        createdAt: "2026-06-27T00:00:00Z",
        lastReinforcedAt: null,
      }),
    ]);

    const out = await withTestScope(() =>
      listMemories({ limit: 100, offset: 0 }),
    );

    expect(out.total).toBe(2);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.id).toBe("m_1");
    expect(out.memories[0]!.publicId).toBe("pub_1");
    expect(out.memories[0]!.nodeRef).toBe("user:mac-anderson");
    expect(out.memories[0]!.lesson).toBe("the user's name is Mac Anderson");
    expect(out.memories[0]!.confidenceScore).toBe(100);

    // Both queries must be tenant-scoped against AgentMemory; page must order
    // newest-first and paginate with SKIP/LIMIT.
    const countCypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    const pageCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(countCypher).toContain(
      "MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})",
    );
    expect(countCypher).toContain("count(m) AS total");
    expect(pageCypher).toContain(
      "MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})",
    );
    expect(pageCypher).toContain("ORDER BY m.createdAt DESC");
    expect(pageCypher).toContain("SKIP $offset");
    expect(pageCypher).toContain("LIMIT $limit");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("forwards offset/limit as BigInt and leaves optional filters null when unset", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() => listMemories({ limit: 50, offset: 25 }));
    const pageParams = sessionRun.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(pageParams.offset).toBe(BigInt(25));
    expect(pageParams.limit).toBe(BigInt(50));
    // No filters supplied → predicate params are null so the WHERE short-circuits.
    expect(pageParams.nodeRef).toBeNull();
    expect(pageParams.memoryClass).toBeNull();
    expect(pageParams.memoryKind).toBeNull();
    expect(pageParams.minEnforcement).toBeNull();
    expect(pageParams.minCitations).toBeNull();
  });

  it("forwards memoryClass/memoryKind/minEnforcement/nodeRef filters", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() =>
      listMemories({
        limit: 100,
        offset: 0,
        memoryClass: "RULE",
        memoryKind: "gotcha",
        minEnforcement: 60,
        nodeRef: "user:mac-anderson",
      }),
    );
    const countParams = sessionRun.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(countParams.memoryClass).toBe("RULE");
    expect(countParams.memoryKind).toBe("gotcha");
    expect(countParams.minEnforcement).toBe(60);
    expect(countParams.nodeRef).toBe("user:mac-anderson");
    const countCypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(countCypher).toContain("$memoryClass IS NULL OR");
    expect(countCypher).toContain("$minEnforcement IS NULL OR");
  });

  it("applies the minCitations floor as a WHERE predicate on both queries", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() =>
      listMemories({ limit: 100, offset: 0, minCitations: 3 }),
    );
    const countCypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    const pageCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(countCypher).toContain(
      "$minCitations IS NULL OR coalesce(m.citation_count, 0) >= $minCitations",
    );
    expect(pageCypher).toContain("$minCitations IS NULL OR");
    const countParams = sessionRun.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(countParams.minCitations).toBe(3);
  });

  it("orders by citation count (desc, recency tie-break) when sort=citationCount", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() =>
      listMemories({ limit: 100, offset: 0, sort: "citationCount" }),
    );
    const pageCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(pageCypher).toContain(
      "ORDER BY coalesce(m.citation_count, 0) DESC, m.createdAt DESC",
    );
  });

  it("orders by citation count ascending when sortDir=asc", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() =>
      listMemories({
        limit: 100,
        offset: 0,
        sort: "citationCount",
        sortDir: "asc",
      }),
    );
    const pageCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(pageCypher).toContain(
      "ORDER BY coalesce(m.citation_count, 0) ASC, m.createdAt DESC",
    );
  });

  it("defaults to newest-first ordering when no sort is supplied", async () => {
    mockCountThenPage(0, []);
    await withTestScope(() => listMemories({ limit: 100, offset: 0 }));
    const pageCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(pageCypher).toContain("ORDER BY m.createdAt DESC");
  });

  it("returns an empty page and total 0 when the tenant has no memories", async () => {
    mockCountThenPage(0, []);
    const out = await withTestScope(() =>
      listMemories({ limit: 100, offset: 0 }),
    );
    expect(out.total).toBe(0);
    expect(out.memories).toEqual([]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("promoteMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("creates a :Promotion event and sets memory_class/enforcement_score", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          publicId: "pub_1",
          nodeRef: "Function:foo",
          memoryClass: "RULE",
          memoryKind: "constraint",
          lesson: "always check auth",
          source: "feature",
          confidenceScore: 90,
          enforcementScore: 80,
          status: "ACTIVE",
          subjectHint: "Function:foo",
          halfLifeDays: 90,
          decayFloor: 5,
          lastEvidenceAt: "2026-06-27T00:00:00Z",
          citationCount: 3,
          influenceCount: 2,
          violationCount: 0,
          createdByKind: "AGENT",
          createdById: "feature",
          confirmedByKind: null,
          confirmedById: null,
          createdAt: "2026-06-27T00:00:00Z",
          lastReinforcedAt: null,
        }),
      ],
    });
    const result = await withTestScope(() =>
      promoteMemory({
        memoryId: "m_1",
        toClass: "RULE",
        enforcementScore: 80,
        promotedByKind: "USER",
        promotedById: "u_1",
        rationale: "cited three times with no deviation",
      }),
    );
    expect(result?.memoryClass).toBe("RULE");
    expect(result?.enforcementScore).toBe(80);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("CREATE (p:Promotion {");
    expect(cypher).toContain("CREATE (p)-[:PROMOTED]->(m)");
    expect(cypher).toContain("m.memory_class = $toClass");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.toClass).toBe("RULE");
    expect(params.enforcement).toBe(80);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("forces enforcement 100 and confirmed_by_kind USER when promoting to FACT", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({ id: "m_1", memoryClass: "FACT", enforcementScore: 100 }),
      ],
    });
    await withTestScope(() =>
      promoteMemory({
        memoryId: "m_1",
        toClass: "FACT",
        enforcementScore: null,
        promotedByKind: "USER",
        promotedById: "u_1",
        rationale: "human confirmed",
        confirmedById: "u_1",
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.enforcement).toBe(100);
    expect(params.confirmedByKind).toBe("USER");
    expect(params.confirmedById).toBe("u_1");
  });

  it("returns null when no memory matched", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() =>
      promoteMemory({
        memoryId: "missing",
        toClass: "RULE",
        enforcementScore: 50,
        promotedByKind: "AGENT",
        promotedById: null,
        rationale: "x",
      }),
    );
    expect(result).toBeNull();
  });
});

describe("listPromotionCandidates", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("returns OBSERVATIONs ranked by citation pressure", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          publicId: "pub_1",
          lesson: "always batch writes",
          memoryKind: "performance",
          citationCount: 5,
          influenceCount: 3,
          confidenceScore: 95,
        }),
      ],
    });
    const candidates = await withTestScope(() =>
      listPromotionCandidates({ limit: 3 }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.citationCount).toBe(5);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain(
      "coalesce(m.memory_class, 'OBSERVATION') = 'OBSERVATION'",
    );
    // The dismissal predicate is what makes a promotion-queue dismiss
    // durable — without it a dismissed memory reappears in the candidate
    // list on the next fetch.
    expect(cypher).toContain("m.promotion_dismissed_at IS NULL");
    expect(cypher).toContain(
      "ORDER BY citationCount DESC, influenceCount DESC",
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.limit).toBe(BigInt(3));
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("demoteMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  function mockCurrentClass(fromClass: string) {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ fromClass })],
    });
  }

  it("FACT → OBSERVATION clears enforcement + confirmation and writes a :Demotion", async () => {
    mockCurrentClass("FACT");
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          publicId: "pub_1",
          memoryClass: "OBSERVATION",
          enforcementScore: null,
        }),
      ],
    });
    const result = await withTestScope(() =>
      demoteMemory({
        memoryId: "m_1",
        toClass: "OBSERVATION",
        demotedByKind: "USER",
        demotedById: "u_1",
        rationale: "no longer confirmed",
      }),
    );
    expect(result?.memoryClass).toBe("OBSERVATION");
    // Second call is the write: it creates the audit node and clears fields.
    const writeCypher = String(sessionRun.mock.calls[1]?.[0] ?? "");
    expect(writeCypher).toContain("CREATE (d:Demotion {");
    expect(writeCypher).toContain("CREATE (d)-[:DEMOTED]->(m)");
    expect(writeCypher).toContain("m.confirmed_by_kind = null");
    expect(writeCypher).toContain("m.confirmed_by_id = null");
    const writeParams = sessionRun.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    // OBSERVATION forces enforcement null even when a score was omitted.
    expect(writeParams.enforcement).toBeNull();
    expect(writeParams.fromClass).toBe("FACT");
    expect(writeParams.toClass).toBe("OBSERVATION");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("RULE → OBSERVATION forces enforcement null even when a score is supplied", async () => {
    mockCurrentClass("RULE");
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          memoryClass: "OBSERVATION",
          enforcementScore: null,
        }),
      ],
    });
    await withTestScope(() =>
      demoteMemory({
        memoryId: "m_1",
        toClass: "OBSERVATION",
        enforcementScore: 90,
        demotedByKind: "AGENT",
        demotedById: null,
        rationale: null,
      }),
    );
    const writeParams = sessionRun.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(writeParams.enforcement).toBeNull();
    expect(writeParams.rationale).toBeNull();
  });

  it("FACT → RULE defaults enforcement to 50 when omitted", async () => {
    mockCurrentClass("FACT");
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({ id: "m_1", memoryClass: "RULE", enforcementScore: 50 }),
      ],
    });
    await withTestScope(() =>
      demoteMemory({
        memoryId: "m_1",
        toClass: "RULE",
        demotedByKind: "USER",
        demotedById: "u_1",
        rationale: null,
      }),
    );
    const writeParams = sessionRun.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(writeParams.enforcement).toBe(50);
  });

  it("FACT → RULE honours an explicit enforcement score", async () => {
    mockCurrentClass("FACT");
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({ id: "m_1", memoryClass: "RULE", enforcementScore: 30 }),
      ],
    });
    await withTestScope(() =>
      demoteMemory({
        memoryId: "m_1",
        toClass: "RULE",
        enforcementScore: 30,
        demotedByKind: "USER",
        demotedById: "u_1",
        rationale: null,
      }),
    );
    const writeParams = sessionRun.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(writeParams.enforcement).toBe(30);
  });

  it("throws MemoryDemotionDirectionError on an upward target (OBSERVATION → RULE)", async () => {
    mockCurrentClass("OBSERVATION");
    await expect(
      withTestScope(() =>
        demoteMemory({
          memoryId: "m_1",
          toClass: "RULE",
          demotedByKind: "USER",
          demotedById: "u_1",
          rationale: null,
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryDemotionDirectionError);
    // Only the class-read query ran; no write was attempted.
    expect(sessionRun).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("throws MemoryDemotionDirectionError on a same-class target (RULE → RULE)", async () => {
    mockCurrentClass("RULE");
    await expect(
      withTestScope(() =>
        demoteMemory({
          memoryId: "m_1",
          toClass: "RULE",
          demotedByKind: "USER",
          demotedById: "u_1",
          rationale: null,
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryDemotionDirectionError);
    expect(sessionRun).toHaveBeenCalledTimes(1);
  });

  it("returns null when no memory matched (not a direction error)", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() =>
      demoteMemory({
        memoryId: "missing",
        toClass: "OBSERVATION",
        demotedByKind: "AGENT",
        demotedById: null,
        rationale: null,
      }),
    );
    expect(result).toBeNull();
    expect(sessionRun).toHaveBeenCalledTimes(1);
  });
});

describe("dismissPromotion", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("stamps promotion_dismissed_at and reports dismissed=true", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_1", dismissed: true })],
    });
    const result = await withTestScope(() =>
      dismissPromotion({ memoryId: "m_1", restore: false }),
    );
    expect(result).toEqual({ memoryId: "m_1", dismissed: true });
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain(
      "m.promotion_dismissed_at = CASE WHEN $restore THEN null ELSE datetime() END",
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.restore).toBe(false);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("clears the marker on restore and reports dismissed=false", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_1", dismissed: false })],
    });
    const result = await withTestScope(() =>
      dismissPromotion({ memoryId: "m_1", restore: true }),
    );
    expect(result).toEqual({ memoryId: "m_1", dismissed: false });
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.restore).toBe(true);
  });

  it("returns null when no memory matched", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() =>
      dismissPromotion({ memoryId: "missing", restore: false }),
    );
    expect(result).toBeNull();
  });
});

describe("readCitationStats", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("aggregates totals, breakdowns, daily series, memory lists, and resolved nodes", async () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    // The six queries run in a fixed order (totals, influence, compliance,
    // daily, per-memory, nodes) on the one session — mock them in that order.
    sessionRun
      .mockResolvedValueOnce({
        records: [
          fakeRecord({
            citations: 20,
            executions: 4,
            memoriesCited: 3,
            nodesCited: 1,
          }),
        ],
      })
      .mockResolvedValueOnce({
        records: [
          fakeRecord({ influence: "DECISIVE", n: 6 }),
          fakeRecord({ influence: "IGNORED", n: 3 }),
        ],
      })
      .mockResolvedValueOnce({
        records: [
          fakeRecord({ compliance: "COMPLIED", n: 15 }),
          fakeRecord({ compliance: "VIOLATION", n: 2 }),
        ],
      })
      .mockResolvedValueOnce({
        records: [fakeRecord({ day: todayKey, citations: 5, violations: 2 })],
      })
      .mockResolvedValueOnce({
        records: [
          fakeRecord({
            memoryId: "m_top",
            publicId: "pub_top",
            lesson: "always batch writes",
            memoryClass: "OBSERVATION",
            memoryKind: "performance",
            citationCount: 10,
            decisiveCount: 5,
            contributingCount: 2,
            consideredCount: 3,
            ignoredCount: 0,
            violationCount: 0,
          }),
          fakeRecord({
            memoryId: "m_useless",
            publicId: "pub_useless",
            lesson: "recalled but never used",
            memoryClass: "OBSERVATION",
            memoryKind: "gotcha",
            citationCount: 4,
            decisiveCount: 0,
            contributingCount: 0,
            consideredCount: 1,
            ignoredCount: 3,
            violationCount: 0,
          }),
          fakeRecord({
            memoryId: "m_rule",
            publicId: "pub_rule",
            lesson: "never skip auth",
            memoryClass: "RULE",
            memoryKind: "constraint",
            citationCount: 6,
            decisiveCount: 1,
            contributingCount: 0,
            consideredCount: 0,
            ignoredCount: 0,
            violationCount: 2,
          }),
        ],
      })
      .mockResolvedValueOnce({
        records: [
          fakeRecord({
            id: "pub_node",
            label: "Repository",
            displayName: "oxagen-platform",
            properties: '{"team":"platform"}',
            citationCount: 7,
            decisiveCount: 2,
            ignoredCount: 1,
          }),
        ],
      });

    const stats = await withTestScope(() =>
      readCitationStats({ days: 30, limit: 10 }),
    );

    expect(stats.totals).toEqual({
      citations: 20,
      executions: 4,
      memoriesCited: 3,
      nodesCited: 1,
    });
    expect(stats.byInfluence).toEqual({ DECISIVE: 6, IGNORED: 3 });
    expect(stats.byCompliance).toEqual({ COMPLIED: 15, VIOLATION: 2 });

    // Daily is zero-filled to the window length; the seeded day carries through.
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.at(-1)).toEqual({
      date: todayKey,
      citations: 5,
      violations: 2,
    });

    // topMemories ranked by citation count desc.
    expect(stats.topMemories.map((m) => m.memoryId)).toEqual([
      "m_top",
      "m_rule",
      "m_useless",
    ]);
    // leastUseful: cited >= 3 with zero decisive AND zero contributing.
    expect(stats.leastUsefulMemories.map((m) => m.memoryId)).toEqual([
      "m_useless",
    ]);
    // mostViolated: RULE/FACT memories with >= 1 violation.
    expect(stats.mostViolatedRules.map((m) => m.memoryId)).toEqual(["m_rule"]);

    // topNodes resolved to the friendly ref shape (never a bare id), properties parsed.
    expect(stats.topNodes).toEqual([
      {
        node: {
          id: "pub_node",
          label: "Repository",
          displayName: "oxagen-platform",
          properties: { team: "platform" },
        },
        citationCount: 7,
        decisiveCount: 2,
        ignoredCount: 1,
      },
    ]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("filters memory targets from graph-node targets by the :AgentMemory label", async () => {
    sessionRun
      .mockResolvedValueOnce({
        records: [
          fakeRecord({
            citations: 0,
            executions: 0,
            memoriesCited: 0,
            nodesCited: 0,
          }),
        ],
      })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] });

    await withTestScope(() => readCitationStats({ days: 7, limit: 5 }));

    const totalsCypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    const nodesCypher = String(sessionRun.mock.calls[5]?.[0] ?? "");
    // AgentMemory ALSO carries :GraphNode, so node counting must exclude it.
    expect(totalsCypher).toContain(
      "target:GraphNode AND NOT target:AgentMemory",
    );
    expect(nodesCypher).toContain("NOT n:AgentMemory");
    // Window is applied on the citation retrieval timestamp.
    expect(totalsCypher).toContain("c.retrieved_at >= datetime($since)");
  });
});

describe("recordExecution", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("MERGEs an :Execution by id and returns its id", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "exec_1" })],
    });
    const result = await withTestScope(() =>
      recordExecution({
        executionRef: "exec_1",
        agentId: "agent_1",
        runId: "run_1",
      }),
    );
    expect(result.executionId).toBe("exec_1");
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("MERGE (e:Execution {id: $executionRef");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("recordCitation", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("creates a :Citation and returns its id", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "cit_1" })],
    });
    const result = await withTestScope(() =>
      recordCitation({
        executionId: "exec_1",
        memoryId: "m_1",
        influence: "DECISIVE",
        compliance: "COMPLIED",
        enforcementAtCite: 80,
        confidenceAtCite: 92,
      }),
    );
    expect(result?.citationId).toBe("cit_1");
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("CREATE (c:Citation {");
    expect(cypher).toContain(
      "m.citation_count = coalesce(m.citation_count, 0) + 1",
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.isInfluential).toBe(true);
    expect(params.isViolation).toBe(false);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("returns null when no citation record came back", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() =>
      recordCitation({
        executionId: "exec_1",
        memoryId: "missing",
        influence: "IGNORED",
        compliance: "NA",
        enforcementAtCite: null,
        confidenceAtCite: 50,
      }),
    );
    expect(result).toBeNull();
  });
});

describe("listExecutionCitations", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("lists citations for an execution with optional compliance/influence filters", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          citationId: "cit_1",
          memoryId: "m_1",
          lesson: "always check auth",
          influence: "DECISIVE",
          compliance: "VIOLATION",
          enforcementAtCite: 90,
          expectedValue: null,
          observedValue: null,
          agentRationale: null,
        }),
      ],
    });
    const citations = await withTestScope(() =>
      listExecutionCitations({
        executionId: "exec_1",
        compliance: "VIOLATION",
      }),
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]!.compliance).toBe("VIOLATION");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.compliance).toBe("VIOLATION");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("attachEvidence", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("creates a supporting :Evidence node and raises confidence by strength*100", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ evidenceId: "ev_1", confidenceScore: 90 })],
    });
    const result = await withTestScope(() =>
      attachEvidence({
        memoryId: "m_1",
        sourceKind: "HUMAN_CONFIRM",
        strength: 0.2,
      }),
    );
    expect(result?.evidenceId).toBe("ev_1");
    expect(result?.confidenceScore).toBe(90);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain(":SUPPORTS");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.delta).toBeCloseTo(20, 5);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("creates a refuting :Evidence node with a negative delta", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ evidenceId: "ev_2", confidenceScore: 50 })],
    });
    await withTestScope(() =>
      attachEvidence({
        memoryId: "m_1",
        sourceKind: "CODE_SCAN",
        strength: 0.3,
        refutes: true,
      }),
    );
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain(":REFUTES");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.delta).toBeCloseTo(-30, 5);
  });

  it("returns null when no memory matched", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() =>
      attachEvidence({
        memoryId: "missing",
        sourceKind: "AGENT_JUDGE",
        strength: 0.1,
      }),
    );
    expect(result).toBeNull();
  });
});
