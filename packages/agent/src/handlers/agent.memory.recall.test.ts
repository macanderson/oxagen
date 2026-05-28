import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  recallMemoriesMock: vi.fn(),
}));

mocks.embedTextMock.mockImplementation(async (q: string) => new Array(1536).fill(q.length));
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

vi.mock("../memory/embed.js", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../memory/neo4j.js", () => ({ recallMemories: mocks.recallMemoriesMock }));

import { agentMemoryRecallHandler } from "./agent.memory.recall.js";

const CTX = {
  tenantId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
};

describe("agent.memory.recall handler", () => {
  beforeEach(() => {
    mocks.embedTextMock.mockClear();
    mocks.recallMemoriesMock.mockClear();
  });

  it("embeds the query and forwards filters to recallMemories", async () => {
    const res = await agentMemoryRecallHandler(
      { query: "find me", minWeight: "high", limit: 5 },
      CTX,
    );
    expect(mocks.embedTextMock).toHaveBeenCalledWith("find me");
    expect(mocks.recallMemoriesMock).toHaveBeenCalledTimes(1);
    const arg = mocks.recallMemoriesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.tenantId).toBe("ten_1");
    expect(arg.workspaceId).toBe("ws_1");
    expect(arg.minWeight).toBe("high");
    expect(arg.limit).toBe(5);
    expect(Array.isArray(arg.embedding)).toBe(true);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]!.id).toBe("m_1");
  });
});
