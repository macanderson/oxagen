import { beforeEach, describe, expect, it, vi } from "vitest";

const { promoteMemoryMock, isKnowledgeGraphEnabledMock } = vi.hoisted(() => ({
  promoteMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ promoteMemory: promoteMemoryMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryPromoteHandler } from "./agent.memory.promote";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

const RECORD = { id: "m_1", memoryClass: "RULE" } as never;

beforeEach(() => {
  promoteMemoryMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.promote handler", () => {
  it("throws when the knowledge graph is disabled and never touches Neo4j", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryPromoteHandler(
        { memoryId: "m_1", toClass: "RULE", enforcementScore: 50 },
        TEST_CTX,
      ),
    ).rejects.toThrow(/Knowledge graph is not configured/);
    expect(promoteMemoryMock).not.toHaveBeenCalled();
  });

  it("promotes to RULE with USER attribution for a human caller", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    promoteMemoryMock.mockResolvedValueOnce(RECORD);

    const out = await agentMemoryPromoteHandler(
      {
        memoryId: "m_1",
        toClass: "RULE",
        enforcementScore: 60,
        rationale: "observed three times",
        basedOnEvidenceIds: ["ev_1"],
      },
      TEST_CTX,
    );

    expect(promoteMemoryMock).toHaveBeenCalledWith({
      memoryId: "m_1",
      toClass: "RULE",
      enforcementScore: 60,
      promotedByKind: "USER",
      promotedById: "u_1",
      rationale: "observed three times",
      confirmedById: null,
      basedOnEvidenceIds: ["ev_1"],
    });
    expect(out).toBe(RECORD);
  });

  it("records AGENT attribution and a null rationale for a background caller", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    promoteMemoryMock.mockResolvedValueOnce(RECORD);

    await agentMemoryPromoteHandler(
      { memoryId: "m_1", toClass: "RULE", enforcementScore: 20 },
      makeCTX({ userId: null }),
    );

    expect(promoteMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enforcementScore: 20,
        promotedByKind: "AGENT",
        promotedById: null,
        rationale: null,
      }),
    );
  });

  it("re-derives the FACT confirmation from the caller, not the input", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    promoteMemoryMock.mockResolvedValueOnce(RECORD);

    await agentMemoryPromoteHandler(
      { memoryId: "m_1", toClass: "FACT" },
      TEST_CTX,
    );

    expect(promoteMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toClass: "FACT",
        // assertMemoryClassInvariants pins a FACT to enforcement 100.
        enforcementScore: 100,
        confirmedById: "u_1",
      }),
    );
  });

  it("leaves the FACT confirmation unattributed when the caller has no user identity", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    promoteMemoryMock.mockResolvedValueOnce(RECORD);

    await agentMemoryPromoteHandler(
      { memoryId: "m_1", toClass: "FACT" },
      makeCTX({ userId: null }),
    );

    expect(promoteMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toClass: "FACT",
        enforcementScore: 100,
        promotedByKind: "AGENT",
        confirmedById: null,
      }),
    );
  });

  it("rejects a RULE promotion with no enforcement score", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    await expect(
      agentMemoryPromoteHandler({ memoryId: "m_1", toClass: "RULE" }, TEST_CTX),
    ).rejects.toThrow(/A RULE requires enforcement_score between 1 and 100/);
    expect(promoteMemoryMock).not.toHaveBeenCalled();
  });

  it("throws a not-found error when promoteMemory reports no match", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    promoteMemoryMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryPromoteHandler(
        { memoryId: "missing", toClass: "RULE", enforcementScore: 10 },
        TEST_CTX,
      ),
    ).rejects.toThrow("Memory missing not found in this workspace.");
  });
});
