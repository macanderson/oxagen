import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  recallMemoriesMock: vi.fn(),
  // reinforceMemory is called fire-and-forget after each recall; must be in the mock.
  reinforceMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
  insertMemoryChangeMock: vi.fn(),
}));

mocks.embedTextMock.mockImplementation(
  async (q: string) => new Array(1536).fill(q.length) as number[],
);
mocks.recallMemoriesMock.mockImplementation(async () => [
  {
    id: "m_1",
    nodeRef: "Function:foo",
    memoryClass: "RULE",
    memoryKind: "constraint",
    lesson: "watch out",
    source: "feature",
    score: 0.9,
    createdAt: "2026-05-28T00:00:00Z",
    confidenceScore: 90,
    enforcementScore: 80,
    lastReinforcedAt: null,
  },
]);
mocks.reinforceMemoryMock.mockResolvedValue({ confidenceScore: 95 });
mocks.insertMemoryChangeMock.mockResolvedValue(undefined);
// Default: KG enabled so existing tests are unaffected.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);

vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../memory/neo4j", () => ({
  recallMemories: mocks.recallMemoriesMock,
  reinforceMemory: mocks.reinforceMemoryMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));
vi.mock("@oxagen/telemetry", () => ({
  insertMemoryChange: mocks.insertMemoryChangeMock,
}));

import { agentMemoryRecallHandler } from "./agent.memory.recall";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.memory.recall handler", () => {
  beforeEach(() => {
    mocks.embedTextMock.mockClear();
    mocks.recallMemoriesMock.mockClear();
    mocks.reinforceMemoryMock.mockClear();
    mocks.isKnowledgeGraphEnabledMock.mockClear();
    mocks.insertMemoryChangeMock.mockClear();
    // Default back to enabled for each test.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
  });

  it("embeds the query and forwards filters to recallMemories", async () => {
    const res = await agentMemoryRecallHandler(
      { query: "find me", memoryClass: "RULE", minEnforcement: 50, limit: 5 },
      CTX,
    );
    expect(mocks.embedTextMock).toHaveBeenCalledWith("find me", {
      telemetry: {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
        executionStepId: "req_1",
      },
    });
    expect(mocks.recallMemoriesMock).toHaveBeenCalledTimes(1);
    const arg = mocks.recallMemoriesMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // orgId/workspaceId are no longer passed directly — scopedSession reads them from the ALS scope
    expect(arg.orgId).toBeUndefined();
    expect(arg.workspaceId).toBeUndefined();
    expect(arg.memoryClass).toBe("RULE");
    expect(arg.minEnforcement).toBe(50);
    expect(arg.limit).toBe(5);
    expect(Array.isArray(arg.embedding)).toBe(true);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]!.id).toBe("m_1");
    expect(res.memories[0]!.memoryClass).toBe("RULE");
    expect(res.memories[0]!.enforcementScore).toBe(80);
  });

  it("fire-and-forgets a fixed +5 reinforcement per recalled memory", async () => {
    await agentMemoryRecallHandler({ query: "find me", limit: 5 }, CTX);
    expect(mocks.reinforceMemoryMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      reinforcementAmount: 5,
    });
  });

  it("returns { memories: [] } immediately when knowledge graph is disabled", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);

    const res = await agentMemoryRecallHandler(
      { query: "anything", limit: 10 },
      CTX,
    );

    // Valid typed output — empty memories array.
    expect(res).toEqual({ memories: [] });
    // Neither Neo4j nor the embedding model is called.
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    expect(mocks.recallMemoriesMock).not.toHaveBeenCalled();
  });
});
