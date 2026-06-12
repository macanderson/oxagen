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
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.lesson).toBe("be careful");
    expect(params.weight).toBe("high");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});
