import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so all mock fns exist when vi.mock factories run.
const mocks = vi.hoisted(() => ({
  writeMemoryMock: vi.fn(),
  getMemoryByIdMock: vi.fn(),
  embedTextMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
  generateObjectForMock: vi.fn(),
}));

const PERSISTED_RECORD = {
  id: "m_new",
  publicId: "pub_new",
  nodeRef: "user-memory",
  memoryClass: "OBSERVATION",
  memoryKind: "constraint",
  lesson: "A captured lesson",
  source: "user",
  confidenceScore: 100,
  enforcementScore: null,
  status: "ACTIVE",
  subjectHint: "user-memory",
  halfLifeDays: 30,
  decayFloor: 5,
  lastEvidenceAt: "2026-06-28T00:00:00Z",
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "USER",
  createdById: "user",
  confirmedByKind: "USER",
  confirmedById: "u_1",
  createdAt: "2026-06-28T00:00:00Z",
  lastReinforcedAt: "2026-06-28T00:00:00Z",
};

mocks.writeMemoryMock.mockResolvedValue({ memoryId: "m_new", edgesCreated: 0 });
mocks.getMemoryByIdMock.mockResolvedValue(PERSISTED_RECORD);
mocks.embedTextMock.mockImplementation(async () => new Array(1536).fill(0.05));
// Default: KG enabled so tests that don't override it work correctly.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
// Default: classifier succeeds and returns constraint/OBSERVATION
mocks.generateObjectForMock.mockResolvedValue({
  object: { memoryClass: "OBSERVATION", memoryKind: "constraint" },
});

vi.mock("../memory/neo4j", () => ({
  writeMemory: mocks.writeMemoryMock,
  getMemoryById: mocks.getMemoryByIdMock,
}));
vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectForMock,
}));

import { agentMemoryRememberHandler } from "./agent.memory.remember";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.memory.remember handler", () => {
  beforeEach(() => {
    mocks.writeMemoryMock.mockClear();
    mocks.getMemoryByIdMock.mockClear();
    mocks.embedTextMock.mockClear();
    mocks.isKnowledgeGraphEnabledMock.mockClear();
    mocks.generateObjectForMock.mockClear();
    // Reset to sensible defaults for each test.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
    mocks.writeMemoryMock.mockResolvedValue({
      memoryId: "m_new",
      edgesCreated: 0,
    });
    mocks.getMemoryByIdMock.mockResolvedValue(PERSISTED_RECORD);
    mocks.embedTextMock.mockImplementation(async () =>
      new Array(1536).fill(0.05),
    );
    mocks.generateObjectForMock.mockResolvedValue({
      object: { memoryClass: "OBSERVATION", memoryKind: "constraint" },
    });
  });

  it("when memoryClass AND memoryKind are both provided, skips classification (classified: false)", async () => {
    const res = await agentMemoryRememberHandler(
      {
        text: "A captured lesson",
        memoryClass: "OBSERVATION",
        memoryKind: "gotcha",
      },
      CTX,
    );
    expect(mocks.generateObjectForMock).not.toHaveBeenCalled();
    expect(res.inferred.classified).toBe(false);
    expect(res.inferred.memoryKind).toBe("gotcha");
    expect(res.inferred.memoryClass).toBe("OBSERVATION");
  });

  it("when memoryClass+memoryKind are both provided, calls writeMemory and getMemoryById", async () => {
    await agentMemoryRememberHandler(
      {
        text: "A captured lesson",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
      },
      CTX,
    );
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(1);
    expect(mocks.getMemoryByIdMock).toHaveBeenCalledWith("m_new");
  });

  it("when memoryClass is omitted, classifies and sets classified: true", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { memoryClass: "RULE", memoryKind: "gotcha" },
    });
    const res = await agentMemoryRememberHandler(
      { text: "A surprising trap", memoryKind: "gotcha" },
      CTX,
    );
    expect(mocks.generateObjectForMock).toHaveBeenCalledTimes(1);
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.memoryClass).toBe("RULE");
  });

  it("when memoryKind is omitted, classifies and sets classified: true", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { memoryClass: "OBSERVATION", memoryKind: "bug-root-cause" },
    });
    const res = await agentMemoryRememberHandler(
      { text: "Root cause discovered", memoryClass: "OBSERVATION" },
      CTX,
    );
    expect(mocks.generateObjectForMock).toHaveBeenCalledTimes(1);
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.memoryKind).toBe("bug-root-cause");
  });

  it("when both memoryClass and memoryKind are omitted, classifies and returns model values", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: {
        memoryClass: "OBSERVATION",
        memoryKind: "convention-deviation",
      },
    });
    const res = await agentMemoryRememberHandler(
      { text: "Changed pattern" },
      CTX,
    );
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.memoryClass).toBe("OBSERVATION");
    expect(res.inferred.memoryKind).toBe("convention-deviation");
  });

  it("falls back to OBSERVATION/constraint and classified:false when generateObjectFor throws", async () => {
    mocks.generateObjectForMock.mockRejectedValueOnce(
      new Error("gateway unavailable"),
    );
    const res = await agentMemoryRememberHandler({ text: "A lesson" }, CTX);
    expect(res.inferred.classified).toBe(false);
    expect(res.inferred.memoryClass).toBe("OBSERVATION");
    expect(res.inferred.memoryKind).toBe("constraint");
    // writeMemory should still be called (graph is enabled) with the safe defaults.
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(1);
  });

  it("defaults enforcementScore to a mid-strength value when classified RULE has no explicit score", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { memoryClass: "RULE", memoryKind: "constraint" },
    });
    await agentMemoryRememberHandler({ text: "Always do X" }, CTX);
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.memoryClass).toBe("RULE");
    expect(typeof arg.enforcementScore).toBe("number");
    expect(arg.enforcementScore).toBeGreaterThanOrEqual(1);
    expect(arg.enforcementScore).toBeLessThanOrEqual(100);
  });

  it("passes a caller-pinned enforcementScore through for a pinned RULE", async () => {
    await agentMemoryRememberHandler(
      {
        text: "Always do X",
        memoryClass: "RULE",
        memoryKind: "constraint",
        enforcementScore: 90,
      },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.enforcementScore).toBe(90);
  });

  it("confirms a user-sourced FACT pin using ctx.userId (source defaults to 'user')", async () => {
    await agentMemoryRememberHandler(
      {
        text: "A confirmed fact",
        memoryClass: "FACT",
        memoryKind: "constraint",
      },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.memoryClass).toBe("FACT");
    expect(arg.enforcementScore).toBe(100);
    expect(arg.confirmedByKind).toBe("USER");
    expect(arg.confirmedById).toBe(CTX.userId);
  });

  it("throws when a non-user-sourced FACT is pinned (no confirmation available)", async () => {
    await expect(
      agentMemoryRememberHandler(
        {
          text: "Unconfirmed fact",
          memoryClass: "FACT",
          memoryKind: "constraint",
          source: "fix",
        },
        CTX,
      ),
    ).rejects.toThrow("confirmed_by_kind = USER");
  });

  it("when graph is disabled, returns a sentinel record with empty id (no Neo4j or embed calls)", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);
    // Both axes supplied so we can isolate the graph-disabled branch.
    const res = await agentMemoryRememberHandler(
      {
        text: "A lesson",
        memoryClass: "OBSERVATION",
        memoryKind: "routine-change",
      },
      CTX,
    );
    expect(res.memory.id).toBe("");
    expect(res.memory.publicId).toBe("");
    expect(res.memory.lesson).toBe("A lesson");
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
    expect(mocks.getMemoryByIdMock).not.toHaveBeenCalled();
  });

  it("when graph is disabled, the returned sentinel record is schema-valid (has required fields)", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);
    const res = await agentMemoryRememberHandler(
      {
        text: "Sentinel test",
        memoryClass: "RULE",
        memoryKind: "gotcha",
        enforcementScore: 90,
      },
      CTX,
    );
    expect(typeof res.memory.createdAt).toBe("string");
    expect(res.memory.lastReinforcedAt).toBeNull();
    expect(res.memory.confidenceScore).toBe(100);
    expect(res.memory.enforcementScore).toBe(90);
    expect(res.memory.status).toBe("ACTIVE");
    expect(res.memory.citationCount).toBe(0);
    expect(res.memory.influenceCount).toBe(0);
    expect(res.memory.violationCount).toBe(0);
  });

  it("uses the nodeRef from input when provided", async () => {
    await agentMemoryRememberHandler(
      {
        text: "Anchored lesson",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        nodeRef: "Function:auth#validate",
      },
      CTX,
    );
    const writeArg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(writeArg.nodeRef).toBe("Function:auth#validate");
  });

  it("defaults nodeRef to 'user-memory' when not supplied", async () => {
    await agentMemoryRememberHandler(
      {
        text: "Free-form note",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
      },
      CTX,
    );
    const writeArg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(writeArg.nodeRef).toBe("user-memory");
  });

  it("returns the record from getMemoryById as the memory field", async () => {
    const res = await agentMemoryRememberHandler(
      {
        text: "A lesson",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
      },
      CTX,
    );
    expect(res.memory).toEqual(PERSISTED_RECORD);
  });

  it("falls back to a constructed record when getMemoryById returns null", async () => {
    mocks.getMemoryByIdMock.mockResolvedValueOnce(null);
    const res = await agentMemoryRememberHandler(
      { text: "A lesson", memoryClass: "OBSERVATION", memoryKind: "gotcha" },
      CTX,
    );
    // Falls back to the constructed record — id equals memoryId from writeMemory
    expect(res.memory.id).toBe("m_new");
    expect(res.memory.lesson).toBe("A lesson");
  });
});
