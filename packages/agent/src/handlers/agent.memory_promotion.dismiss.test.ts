import { describe, expect, it, vi, beforeEach } from "vitest";

const { dismissPromotionMock, isKnowledgeGraphEnabledMock } = vi.hoisted(
  () => ({
    dismissPromotionMock: vi.fn(),
    isKnowledgeGraphEnabledMock: vi.fn(),
  }),
);

vi.mock("../memory/neo4j", () => ({ dismissPromotion: dismissPromotionMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryPromotionDismissHandler } from "./agent.memory_promotion.dismiss";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => {
  dismissPromotionMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.promotion.dismiss handler", () => {
  it("throws when the knowledge graph is disabled and never touches Neo4j", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryPromotionDismissHandler(
        { memoryId: "m_1", restore: false },
        CTX,
      ),
    ).rejects.toThrow(/Knowledge graph is not configured/);
    expect(dismissPromotionMock).not.toHaveBeenCalled();
  });

  it("dismisses a memory and returns dismissed=true", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    dismissPromotionMock.mockResolvedValueOnce({
      memoryId: "m_1",
      dismissed: true,
    });

    const out = await agentMemoryPromotionDismissHandler(
      { memoryId: "m_1", restore: false },
      CTX,
    );

    expect(dismissPromotionMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      restore: false,
    });
    expect(out).toEqual({ memoryId: "m_1", dismissed: true });
  });

  it("restores a memory and returns dismissed=false", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    dismissPromotionMock.mockResolvedValueOnce({
      memoryId: "m_1",
      dismissed: false,
    });

    const out = await agentMemoryPromotionDismissHandler(
      { memoryId: "m_1", restore: true },
      CTX,
    );

    expect(dismissPromotionMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      restore: true,
    });
    expect(out).toEqual({ memoryId: "m_1", dismissed: false });
  });

  it("throws a not-found error when dismissPromotion reports no match", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    dismissPromotionMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryPromotionDismissHandler(
        { memoryId: "missing", restore: false },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
  });
});
