import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so the fns exist when vi.mock factory runs.
const { deleteMemoryMock, isKnowledgeGraphEnabledMock } = vi.hoisted(() => ({
  deleteMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ deleteMemory: deleteMemoryMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryDeleteHandler } from "./agent.memory.delete";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => {
  deleteMemoryMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.delete handler", () => {
  it("returns { deleted: false } when the knowledge graph is disabled and does not touch Neo4j", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    const out = await agentMemoryDeleteHandler({ memoryId: "m_1" }, CTX);
    expect(out).toEqual({ deleted: false, memoryId: "m_1" });
    expect(deleteMemoryMock).not.toHaveBeenCalled();
  });

  it("calls deleteMemory with the memoryId and returns { deleted: true } on a match", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    deleteMemoryMock.mockResolvedValueOnce(true);

    const out = await agentMemoryDeleteHandler({ memoryId: "m_abc" }, CTX);

    expect(deleteMemoryMock).toHaveBeenCalledTimes(1);
    expect(deleteMemoryMock).toHaveBeenCalledWith({ memoryId: "m_abc" });
    expect(out).toEqual({ deleted: true, memoryId: "m_abc" });
  });

  it("echoes the memoryId in the output even when deleteMemory reports no match", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    deleteMemoryMock.mockResolvedValueOnce(false);

    const out = await agentMemoryDeleteHandler({ memoryId: "missing_id" }, CTX);
    expect(out).toEqual({ deleted: false, memoryId: "missing_id" });
  });
});
