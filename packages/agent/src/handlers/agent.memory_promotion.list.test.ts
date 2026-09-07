import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPromotionCandidatesMock, isKnowledgeGraphEnabledMock } = vi.hoisted(
  () => ({
    listPromotionCandidatesMock: vi.fn(),
    isKnowledgeGraphEnabledMock: vi.fn(),
  }),
);

vi.mock("../memory/neo4j", () => ({
  listPromotionCandidates: listPromotionCandidatesMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryPromotionCandidatesHandler } from "./agent.memory_promotion.list";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => {
  listPromotionCandidatesMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.promotion.candidates handler", () => {
  it("returns no candidates without querying when the graph is disabled", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryPromotionCandidatesHandler({ limit: 10 }, TEST_CTX),
    ).resolves.toEqual({ candidates: [] });
    expect(listPromotionCandidatesMock).not.toHaveBeenCalled();
  });

  it("passes the requested limit through to the graph query", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    const candidates = [{ memoryId: "m_1", citationCount: 9 }];
    listPromotionCandidatesMock.mockResolvedValueOnce(candidates);

    const out = await agentMemoryPromotionCandidatesHandler(
      { limit: 5 },
      TEST_CTX,
    );

    expect(listPromotionCandidatesMock).toHaveBeenCalledWith({ limit: 5 });
    expect(out.candidates).toBe(candidates);
  });
});
