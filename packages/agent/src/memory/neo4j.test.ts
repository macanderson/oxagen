import { describe, expect, it, vi, beforeEach } from "vitest";

const sessionRun = vi.fn();
const sessionClose = vi.fn(async () => undefined);

vi.mock("@oxagen/ontology", () => ({
  session: () => ({ run: sessionRun, close: sessionClose }),
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
    const rows = await recallMemories({
      orgId: "ten_1",
      workspaceId: "ws_1",
      embedding: new Array<number>(1536).fill(0.1),
      minWeight: "high",
      limit: 10,
    });
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("agent_memory_embedding");
    expect(cypher).toContain("orgId");
    expect(cypher).toContain("workspaceId");
    expect(cypher).toContain("$minRank");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.orgId).toBe("ten_1");
    expect(params.workspaceId).toBe("ws_1");
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
    const res = await writeMemory({
      orgId: "ten_1",
      workspaceId: "ws_1",
      nodeRef: "Function:foo",
      embedding: new Array<number>(1536).fill(0.2),
      weight: "high",
      kind: "constraint",
      lesson: "be careful",
      source: "feature",
    });
    expect(res.memoryId).toBe("m_new");
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("MERGE (m:AgentMemory");
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("nodeRef: $nodeRef");
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.lesson).toBe("be careful");
    expect(params.weight).toBe("high");
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
});
