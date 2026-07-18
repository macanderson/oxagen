import { describe, expect, it, vi, beforeEach } from "vitest";

const { readCitationStatsMock, isKnowledgeGraphEnabledMock } = vi.hoisted(
  () => ({
    readCitationStatsMock: vi.fn(),
    isKnowledgeGraphEnabledMock: vi.fn(),
  }),
);

vi.mock("../memory/neo4j", () => ({
  readCitationStats: readCitationStatsMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryCitationStatsHandler } from "./agent.memory_citation.stats";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => {
  readCitationStatsMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.citations.stats handler", () => {
  it("returns an empty-but-valid rollup when the knowledge graph is disabled", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    const out = await agentMemoryCitationStatsHandler(
      { days: 30, limit: 10 },
      CTX,
    );
    expect(out).toEqual({
      totals: { citations: 0, executions: 0, memoriesCited: 0, nodesCited: 0 },
      byInfluence: {},
      byCompliance: {},
      daily: [],
      topMemories: [],
      leastUsefulMemories: [],
      mostViolatedRules: [],
      topNodes: [],
    });
    expect(readCitationStatsMock).not.toHaveBeenCalled();
  });

  it("forwards the window/limit and returns the computed rollup", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    const rollup = {
      totals: { citations: 3, executions: 2, memoriesCited: 1, nodesCited: 1 },
      byInfluence: { DECISIVE: 2, IGNORED: 1 },
      byCompliance: { COMPLIED: 3 },
      daily: [{ date: "2026-07-18", citations: 3, violations: 0 }],
      topMemories: [],
      leastUsefulMemories: [],
      mostViolatedRules: [],
      topNodes: [],
    };
    readCitationStatsMock.mockResolvedValueOnce(rollup);

    const out = await agentMemoryCitationStatsHandler(
      { days: 7, limit: 5 },
      CTX,
    );

    expect(readCitationStatsMock).toHaveBeenCalledWith({ days: 7, limit: 5 });
    expect(out).toBe(rollup);
  });
});
