import { beforeEach, describe, expect, it, vi } from "vitest";

const { listExecutionCitationsMock, isKnowledgeGraphEnabledMock } = vi.hoisted(
  () => ({
    listExecutionCitationsMock: vi.fn(),
    isKnowledgeGraphEnabledMock: vi.fn(),
  }),
);

vi.mock("../memory/neo4j", () => ({
  listExecutionCitations: listExecutionCitationsMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryCitationsListHandler } from "./agent.memory_citation.list";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => {
  listExecutionCitationsMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.citations.list handler", () => {
  it("returns an empty list without querying when the graph is disabled", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryCitationsListHandler({ executionId: "exec_1" }, TEST_CTX),
    ).resolves.toEqual({ citations: [] });
    expect(listExecutionCitationsMock).not.toHaveBeenCalled();
  });

  it("forwards the compliance and influence filters to the graph query", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    const citations = [{ citationId: "cit_1" }];
    listExecutionCitationsMock.mockResolvedValueOnce(citations);

    const out = await agentMemoryCitationsListHandler(
      {
        executionId: "exec_1",
        compliance: "VIOLATION",
        influenceIn: ["DECISIVE", "CONTRIBUTING"],
      } as Parameters<typeof agentMemoryCitationsListHandler>[0],
      TEST_CTX,
    );

    expect(listExecutionCitationsMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      compliance: "VIOLATION",
      influenceIn: ["DECISIVE", "CONTRIBUTING"],
    });
    expect(out.citations).toBe(citations);
  });
});
