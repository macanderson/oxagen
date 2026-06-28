import { describe, expect, it, vi, beforeEach } from "vitest";
import { withTestScope } from "@oxagen/tenancy/testing";

const sessionRun = vi.fn();
const sessionClose = vi.fn(async () => undefined);

vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: sessionRun, close: sessionClose }),
}));

import { recallMemories, writeMemory } from "./neo4j";

function fakeRecord(map: Record<string, unknown>) {
  return { get: (k: string) => map[k] };
}

describe("memory neo4j", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("recallMemories queries the vector index with tenant + weight filters", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          nodeRef: "Function:foo",
          weight: "high",
          kind: "constraint",
          lesson: "watch out",
          source: "feature",
          score: 0.92,
          createdAt: "2026-05-28T00:00:00Z",
        }),
      ],
    });
    const rows = await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        minWeight: "high",
        limit: 10,
      }),
    );
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    // Cypher must reference $orgId (guard) and workspaceId filter
    expect(cypher).toContain("memory_embedding_index");
    expect(cypher).toContain("node.orgId = $orgId");
    expect(cypher).toContain("workspaceId");
    expect(cypher).toContain("$minRank");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    // orgId/workspaceId are injected by scopedSession (real impl), not threaded
    // through the function args; the mock here bypasses injection, so params
    // does not contain them — that is the correct test surface for this layer.
    expect(params.orgId).toBeUndefined();
    expect(params.workspaceId).toBeUndefined();
    expect(params.minRank).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("m_1");
    expect(rows[0]!.score).toBe(0.92);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("writeMemory MERGE on AgentMemory and returns memory id", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_new" })],
    });
    const res = await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:foo",
        embedding: new Array<number>(1536).fill(0.2),
        weight: "high",
        kind: "constraint",
        lesson: "be careful",
        source: "feature",
      }),
    );
    expect(res.memoryId).toBe("m_new");
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    // Cypher must contain MERGE key with orgId (guard) and nodeRef
    expect(cypher).toContain("MERGE (m:AgentMemory");
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("nodeRef: $nodeRef");
    // The optional REMEMBERS source match must be tenant-scoped so a
    // user-supplied nodeRef can never reach another tenant's node.
    expect(cypher).toContain("OPTIONAL MATCH (target { id: $nodeRef, orgId: $orgId })");
    // The edge-count must live in a CALL subquery so an empty relatedNodeIds
    // list (UNWIND []) does not collapse the outer m row to zero records.
    expect(cypher).toContain("CALL {");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.lesson).toBe("be careful");
    expect(params.weight).toBe("high");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("writeMemory returns the memory id even when relatedNodeIds is empty", async () => {
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
        weight: "low",
        kind: "constraint",
        lesson: "no related nodes",
        source: "feature",
      }),
    );
    expect(res.memoryId).toBe("m_empty");
    expect(res.edgesCreated).toBe(0);
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.relatedNodeIds).toEqual([]);
  });

  it("writeMemory throws when the MERGE returns no record", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await expect(
      withTestScope(() =>
        writeMemory({
          nodeRef: "Function:foo",
          embedding: new Array<number>(1536).fill(0.2),
          weight: "high",
          kind: "constraint",
          lesson: "boom",
          source: "feature",
        }),
      ),
    ).rejects.toThrow("writeMemory: MERGE returned no record");
  });
});

import { reinforceMemory, applyDecayToMemory } from "./neo4j";

describe("reinforceMemory", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("returns capped confidence of 1.0 when increment would exceed cap", async () => {
    // The Cypher CASE caps at 1.0 server-side; mock returns 1.0 to simulate that.
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ confidence: 1.0 })],
    });
    const result = await withTestScope(() =>
      reinforceMemory({ memoryId: "m1", reinforcementAmount: 0.05 }),
    );
    expect(result.confidence).toBe(1.0);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("m.confidence = CASE WHEN");
    expect(cypher).toContain("THEN 1.0");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("m1");
    expect(params.amount).toBe(0.05);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("returns the incremented confidence when well below cap", async () => {
    // 0.8 + 0.05 = 0.85 — no cap needed
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ confidence: 0.85 })],
    });
    const result = await withTestScope(() =>
      reinforceMemory({ memoryId: "m2", reinforcementAmount: 0.05 }),
    );
    expect(result.confidence).toBeCloseTo(0.85, 5);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("passes memoryId and amount params to the query", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ confidence: 0.9 })],
    });
    await withTestScope(() =>
      reinforceMemory({ memoryId: "m_xyz", reinforcementAmount: 0.1 }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("m_xyz");
    expect(params.amount).toBe(0.1);
  });
});

describe("recallMemories — recallThreshold filtering", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("passes recallThreshold to the Cypher query and only returns rows above threshold", async () => {
    // The WHERE clause in neo4j.ts filters server-side; the mock returns
    // only the two rows that pass a 0.1 threshold (0.5 and 0.95 >= 0.1).
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_high",
          nodeRef: "Function:bar",
          weight: "high",
          kind: "constraint",
          lesson: "important",
          source: "feature",
          score: 0.9,
          createdAt: "2026-05-28T00:00:00Z",
          confidence: 0.95,
          lastReinforcedAt: null,
        }),
        fakeRecord({
          id: "m_mid",
          nodeRef: "Function:bar",
          weight: "low",
          kind: "note",
          lesson: "medium",
          source: "feature",
          score: 0.7,
          createdAt: "2026-05-28T00:00:00Z",
          confidence: 0.5,
          lastReinforcedAt: null,
        }),
      ],
    });

    const rows = await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        minWeight: "low",
        limit: 10,
        recallThreshold: 0.1,
      }),
    );

    // The threshold must be forwarded to the Cypher params.
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recallThreshold).toBe(0.1);

    // The Cypher WHERE clause must reference the threshold param.
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("$recallThreshold");

    // Both rows returned by the mock satisfy the threshold.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.confidence >= 0.1)).toBe(true);
    expect(rows[0]!.id).toBe("m_high");
    expect(rows[1]!.id).toBe("m_mid");

    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("a row with confidence 0.05 would be excluded — the mock proves threshold wiring", async () => {
    // When only the low-confidence row is returned (server filtered it out),
    // we verify the threshold param was forwarded correctly.
    sessionRun.mockResolvedValueOnce({ records: [] });
    const rows = await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        minWeight: "low",
        limit: 10,
        recallThreshold: 0.1,
      }),
    );
    expect(rows).toHaveLength(0);
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recallThreshold).toBe(0.1);
  });

  it("defaults recallThreshold to 0 when not supplied", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      recallMemories({
        embedding: new Array<number>(1536).fill(0.1),
        minWeight: "low",
        limit: 5,
      }),
    );
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recallThreshold).toBe(0);
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
      applyDecayToMemory({ memoryId: "m_decay", newConfidence: 0.42 }),
    );
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("$newConfidence");
    expect(cypher).toContain("m.confidence = $newConfidence");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("m_decay");
    expect(params.newConfidence).toBe(0.42);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session even when the query succeeds with zero records", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() =>
      applyDecayToMemory({ memoryId: "m_zero", newConfidence: 0.1 }),
    );
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("writeMemory — ON CREATE SET confidence=1.0", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockClear();
  });

  it("Cypher contains m.confidence = 1.0 in the ON CREATE SET block", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m_new2", edgesCreated: 0 })],
    });
    await withTestScope(() =>
      writeMemory({
        nodeRef: "Function:baz",
        embedding: new Array<number>(1536).fill(0.1),
        weight: "high",
        kind: "constraint",
        lesson: "confidence starts at 1",
        source: "feature",
      }),
    );
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    // The ON CREATE SET block must initialise confidence to exactly 1.0.
    expect(cypher).toContain("m.confidence = 1.0");
  });
});
