import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted lifts mock factory fns so they exist when vi.mock runs.
const mocks = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  updateMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

const UPDATED_RECORD = {
  id: "m_1",
  publicId: "pub_1",
  nodeRef: "Function:foo",
  memoryClass: "RULE",
  memoryKind: "constraint",
  lesson: "Updated lesson",
  source: "feature",
  confidenceScore: 90,
  enforcementScore: 70,
  status: "ACTIVE",
  subjectHint: "Function:foo",
  halfLifeDays: 90,
  decayFloor: 5,
  lastEvidenceAt: "2026-06-27T00:00:00Z",
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "AGENT",
  createdById: "feature",
  confirmedByKind: null,
  confirmedById: null,
  createdAt: "2026-06-27T00:00:00Z",
  lastReinforcedAt: null,
};

mocks.embedTextMock.mockImplementation(async () => new Array(1536).fill(0.1));
mocks.updateMemoryMock.mockResolvedValue(UPDATED_RECORD);
// Default: KG enabled so existing tests are unaffected.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);

vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../memory/neo4j", () => ({ updateMemory: mocks.updateMemoryMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));

import { agentMemoryUpdateHandler } from "./agent.memory.update";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.memory.update handler", () => {
  beforeEach(() => {
    mocks.embedTextMock.mockClear();
    mocks.updateMemoryMock.mockClear();
    mocks.isKnowledgeGraphEnabledMock.mockClear();
    // Default back to enabled and a successful update for each test.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
    mocks.updateMemoryMock.mockResolvedValue(UPDATED_RECORD);
  });

  it("throws when no mutable field is provided", async () => {
    await expect(
      agentMemoryUpdateHandler({ memoryId: "m_1" }, CTX),
    ).rejects.toThrow("agent.memory.update requires at least one field");
    expect(mocks.updateMemoryMock).not.toHaveBeenCalled();
  });

  it("throws when knowledge graph is disabled, even if a field is supplied", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryUpdateHandler({ memoryId: "m_1", confidenceScore: 50 }, CTX),
    ).rejects.toThrow("Knowledge graph is not configured");
    expect(mocks.updateMemoryMock).not.toHaveBeenCalled();
  });

  it("re-embeds when lesson is provided and passes the embedding to updateMemory", async () => {
    const res = await agentMemoryUpdateHandler(
      { memoryId: "m_1", lesson: "New lesson text" },
      CTX,
    );
    expect(mocks.embedTextMock).toHaveBeenCalledWith("New lesson text", {
      telemetry: {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
        executionStepId: "req_1",
      },
    });
    const updateArg = mocks.updateMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Array.isArray(updateArg.embedding)).toBe(true);
    expect((updateArg.embedding as number[]).length).toBe(1536);
    expect(res.id).toBe("m_1");
  });

  it("does NOT embed when lesson is absent — embedding is undefined in updateMemory call", async () => {
    await agentMemoryUpdateHandler(
      { memoryId: "m_1", enforcementScore: 90 },
      CTX,
    );
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    const updateArg = mocks.updateMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArg.embedding).toBeUndefined();
  });

  it("forwards all provided fields to updateMemory", async () => {
    await agentMemoryUpdateHandler(
      {
        memoryId: "m_2",
        memoryKind: "gotcha",
        source: "fix",
        confidenceScore: 50,
        enforcementScore: 40,
        status: "ARCHIVED",
      },
      CTX,
    );
    const updateArg = mocks.updateMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArg.memoryId).toBe("m_2");
    expect(updateArg.memoryKind).toBe("gotcha");
    expect(updateArg.source).toBe("fix");
    expect(updateArg.confidenceScore).toBe(50);
    expect(updateArg.enforcementScore).toBe(40);
    expect(updateArg.status).toBe("ARCHIVED");
  });

  it("returns the updated record produced by updateMemory", async () => {
    const res = await agentMemoryUpdateHandler(
      { memoryId: "m_1", memoryKind: "convention-deviation" },
      CTX,
    );
    expect(res.memoryClass).toBe("RULE");
    expect(res.memoryKind).toBe("constraint");
    expect(res.confidenceScore).toBe(90);
    expect(res.enforcementScore).toBe(70);
  });

  it("throws (not found) when updateMemory returns null", async () => {
    mocks.updateMemoryMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryUpdateHandler(
        { memoryId: "missing_id", confidenceScore: 50 },
        CTX,
      ),
    ).rejects.toThrow("missing_id");
  });
});
