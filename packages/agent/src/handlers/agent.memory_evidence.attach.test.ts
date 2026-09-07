import { beforeEach, describe, expect, it, vi } from "vitest";

const { attachEvidenceMock, isKnowledgeGraphEnabledMock } = vi.hoisted(() => ({
  attachEvidenceMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ attachEvidence: attachEvidenceMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryEvidenceAttachHandler } from "./agent.memory_evidence.attach";
import { TEST_CTX } from "../test-utils/fixtures";

const INPUT = {
  memoryId: "m_1",
  sourceKind: "CITATION",
  strength: 25,
  detail: "run exec_1 corroborated the rule",
  refutes: false,
} as Parameters<typeof agentMemoryEvidenceAttachHandler>[0];

beforeEach(() => {
  attachEvidenceMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.evidence.attach handler", () => {
  it("throws when the knowledge graph is disabled and never touches Neo4j", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryEvidenceAttachHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/Knowledge graph is not configured/);
    expect(attachEvidenceMock).not.toHaveBeenCalled();
  });

  it("forwards the evidence shape and returns the adjusted confidence", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    const result = { evidenceId: "ev_1", confidenceScore: 71 };
    attachEvidenceMock.mockResolvedValueOnce(result);

    await expect(
      agentMemoryEvidenceAttachHandler(INPUT, TEST_CTX),
    ).resolves.toBe(result);
    expect(attachEvidenceMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      sourceKind: "CITATION",
      strength: 25,
      detail: "run exec_1 corroborated the rule",
      refutes: false,
    });
  });

  it("throws a not-found error when the memory is absent from the workspace", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    attachEvidenceMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryEvidenceAttachHandler(
        { ...INPUT, memoryId: "missing" },
        TEST_CTX,
      ),
    ).rejects.toThrow("Memory missing not found in this workspace.");
  });
});
