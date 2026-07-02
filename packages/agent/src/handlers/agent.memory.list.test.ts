import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock is hoisted above const declarations, so the mock factories cannot
// close over plain top-level consts (they'd be read before initialization).
// vi.hoisted lifts the fns alongside the mock registration so both exist when
// the factory runs.
const { listMemories, isKnowledgeGraphEnabled } = vi.hoisted(() => ({
  listMemories: vi.fn(),
  isKnowledgeGraphEnabled: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ listMemories }));
vi.mock("../runtime/knowledge-graph", () => ({ isKnowledgeGraphEnabled }));

import { agentMemoryListHandler } from "./agent.memory.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => {
  listMemories.mockReset();
  isKnowledgeGraphEnabled.mockReset();
});

describe("agent.memory.list handler", () => {
  it("returns an empty, schema-valid page when the knowledge graph is disabled", async () => {
    isKnowledgeGraphEnabled.mockReturnValue(false);
    const out = await agentMemoryListHandler(
      { limit: 100, offset: 0, sort: "createdAt", sortDir: "desc" },
      CTX,
    );
    expect(out).toEqual({ memories: [], total: 0 });
    // Must NOT touch Neo4j when the graph isn't configured.
    expect(listMemories).not.toHaveBeenCalled();
  });

  it("forwards filters to listMemories and returns its page + total", async () => {
    isKnowledgeGraphEnabled.mockReturnValue(true);
    listMemories.mockResolvedValueOnce({
      memories: [
        {
          id: "m_1",
          publicId: "pub_1",
          nodeRef: "user:mac-anderson",
          memoryClass: "RULE",
          memoryKind: "constraint",
          lesson: "the user's name is Mac Anderson",
          source: "feature",
          confidenceScore: 100,
          enforcementScore: 80,
          status: "ACTIVE",
          subjectHint: "user:mac-anderson",
          halfLifeDays: 90,
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
        },
      ],
      total: 1,
    });

    const out = await agentMemoryListHandler(
      {
        limit: 50,
        offset: 10,
        memoryClass: "RULE",
        memoryKind: "constraint",
        minEnforcement: 50,
        nodeRef: "user:mac-anderson",
        sort: "createdAt",
        sortDir: "desc",
      },
      CTX,
    );

    expect(listMemories).toHaveBeenCalledWith({
      limit: 50,
      offset: 10,
      memoryClass: "RULE",
      memoryKind: "constraint",
      minEnforcement: 50,
      minCitations: undefined,
      sort: "createdAt",
      sortDir: "desc",
      nodeRef: "user:mac-anderson",
    });
    expect(out.total).toBe(1);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.nodeRef).toBe("user:mac-anderson");
  });

  it("forwards the citation sort axis and minCitations floor to listMemories", async () => {
    isKnowledgeGraphEnabled.mockReturnValue(true);
    listMemories.mockResolvedValueOnce({ memories: [], total: 0 });

    await agentMemoryListHandler(
      {
        limit: 100,
        offset: 0,
        minCitations: 3,
        sort: "citationCount",
        sortDir: "desc",
      },
      CTX,
    );

    expect(listMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        minCitations: 3,
        sort: "citationCount",
        sortDir: "desc",
      }),
    );
  });
});
