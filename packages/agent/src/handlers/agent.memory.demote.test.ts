import { describe, expect, it, vi, beforeEach } from "vitest";

const { demoteMemoryMock, isKnowledgeGraphEnabledMock } = vi.hoisted(() => ({
  demoteMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ demoteMemory: demoteMemoryMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryDemoteHandler } from "./agent.memory.demote";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

const RECORD = {
  id: "m_1",
  memoryClass: "OBSERVATION",
  enforcementScore: null,
} as never;

beforeEach(() => {
  demoteMemoryMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.demote handler", () => {
  it("throws when the knowledge graph is disabled and never touches Neo4j", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryDemoteHandler(
        { memoryId: "m_1", toClass: "OBSERVATION" },
        TEST_CTX,
      ),
    ).rejects.toThrow(/Knowledge graph is not configured/);
    expect(demoteMemoryMock).not.toHaveBeenCalled();
  });

  it("records USER attribution and forwards enforcement/rationale for a human caller", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    demoteMemoryMock.mockResolvedValueOnce(RECORD);

    const out = await agentMemoryDemoteHandler(
      {
        memoryId: "m_1",
        toClass: "RULE",
        enforcementScore: 40,
        rationale: "why",
      },
      TEST_CTX,
    );

    expect(demoteMemoryMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      toClass: "RULE",
      enforcementScore: 40,
      demotedByKind: "USER",
      demotedById: "u_1",
      rationale: "why",
    });
    expect(out).toBe(RECORD);
  });

  it("records AGENT attribution and null enforcement/rationale for a background caller", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    demoteMemoryMock.mockResolvedValueOnce(RECORD);

    await agentMemoryDemoteHandler(
      { memoryId: "m_1", toClass: "OBSERVATION" },
      makeCTX({ userId: null }),
    );

    expect(demoteMemoryMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      toClass: "OBSERVATION",
      enforcementScore: null,
      demotedByKind: "AGENT",
      demotedById: null,
      rationale: null,
    });
  });

  it("throws a not-found error when demoteMemory reports no match", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    demoteMemoryMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryDemoteHandler(
        { memoryId: "missing", toClass: "OBSERVATION" },
        TEST_CTX,
      ),
    ).rejects.toThrow(/not found/);
  });
});
