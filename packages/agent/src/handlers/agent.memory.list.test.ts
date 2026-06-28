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
      { limit: 100, offset: 0 },
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
          weight: "high",
          kind: "constraint",
          lesson: "the user's name is Mac Anderson",
          source: "feature",
          confidence: 1,
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
        minWeight: "high",
        kind: "constraint",
        nodeRef: "user:mac-anderson",
      },
      CTX,
    );

    expect(listMemories).toHaveBeenCalledWith({
      limit: 50,
      offset: 10,
      minWeight: "high",
      kind: "constraint",
      nodeRef: "user:mac-anderson",
    });
    expect(out.total).toBe(1);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.nodeRef).toBe("user:mac-anderson");
  });
});
