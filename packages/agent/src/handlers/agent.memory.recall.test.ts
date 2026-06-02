import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  recallMemoriesMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

mocks.embedTextMock.mockImplementation(async (q: string) => new Array(1536).fill(q.length) as number[]);
mocks.recallMemoriesMock.mockImplementation(async () => [
  {
    id: "m_1",
    nodeRef: "Function:foo",
    weight: "high",
    kind: "constraint",
    lesson: "watch out",
    source: "feature",
    score: 0.9,
    createdAt: "2026-05-28T00:00:00Z",
  },
]);
// Default: KG enabled so existing tests are unaffected.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);

vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../memory/neo4j", () => ({ recallMemories: mocks.recallMemoriesMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));

import { agentMemoryRecallHandler } from "./agent.memory.recall";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("agent.memory.recall handler", () => {
  beforeEach(() => {
    mocks.embedTextMock.mockClear();
    mocks.recallMemoriesMock.mockClear();
    mocks.isKnowledgeGraphEnabledMock.mockClear();
    // Default back to enabled for each test.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
  });

  it("embeds the query and forwards filters to recallMemories", async () => {
    const res = await agentMemoryRecallHandler(
      { query: "find me", minWeight: "high", limit: 5 },
      CTX,
    );
    expect(mocks.embedTextMock).toHaveBeenCalledWith("find me", {
      telemetry: {
        orgId: "ten_1",
        workspaceId: "ws_1",
        surface: "runner",
        executionStepId: "req_1",
      },
    });
    expect(mocks.recallMemoriesMock).toHaveBeenCalledTimes(1);
    const arg = mocks.recallMemoriesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.orgId).toBe("ten_1");
    expect(arg.workspaceId).toBe("ws_1");
    expect(arg.minWeight).toBe("high");
    expect(arg.limit).toBe(5);
    expect(Array.isArray(arg.embedding)).toBe(true);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]!.id).toBe("m_1");
  });

  it("returns { memories: [] } immediately when knowledge graph is disabled", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);

    const res = await agentMemoryRecallHandler(
      { query: "anything", minWeight: "low", limit: 10 },
      CTX,
    );

    // Valid typed output — empty memories array.
    expect(res).toEqual({ memories: [] });
    // Neither Neo4j nor the embedding model is called.
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    expect(mocks.recallMemoriesMock).not.toHaveBeenCalled();
  });
});
