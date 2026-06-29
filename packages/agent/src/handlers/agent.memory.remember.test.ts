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
  weight: "high",
  kind: "constraint",
  lesson: "A captured lesson",
  source: "user",
  confidence: 1,
  createdAt: "2026-06-28T00:00:00Z",
  lastReinforcedAt: "2026-06-28T00:00:00Z",
};

mocks.writeMemoryMock.mockResolvedValue({ memoryId: "m_new", edgesCreated: 0 });
mocks.getMemoryByIdMock.mockResolvedValue(PERSISTED_RECORD);
mocks.embedTextMock.mockImplementation(async () => new Array(1536).fill(0.05));
// Default: KG enabled so tests that don't override it work correctly.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
// Default: classifier succeeds and returns constraint/high
mocks.generateObjectForMock.mockResolvedValue({
  object: { kind: "constraint", weight: "high" },
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
    mocks.writeMemoryMock.mockResolvedValue({ memoryId: "m_new", edgesCreated: 0 });
    mocks.getMemoryByIdMock.mockResolvedValue(PERSISTED_RECORD);
    mocks.embedTextMock.mockImplementation(async () => new Array(1536).fill(0.05));
    mocks.generateObjectForMock.mockResolvedValue({
      object: { kind: "constraint", weight: "high" },
    });
  });

  it("when kind AND weight are both provided, skips classification (classified: false)", async () => {
    const res = await agentMemoryRememberHandler(
      { text: "A captured lesson", kind: "gotcha", weight: "critical" },
      CTX,
    );
    expect(mocks.generateObjectForMock).not.toHaveBeenCalled();
    expect(res.inferred.classified).toBe(false);
    expect(res.inferred.kind).toBe("gotcha");
    expect(res.inferred.weight).toBe("critical");
  });

  it("when kind+weight are both provided, calls writeMemory and getMemoryById", async () => {
    await agentMemoryRememberHandler(
      { text: "A captured lesson", kind: "constraint", weight: "high" },
      CTX,
    );
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(1);
    expect(mocks.getMemoryByIdMock).toHaveBeenCalledWith("m_new");
  });

  it("when kind is omitted, classifies and sets classified: true", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { kind: "gotcha", weight: "high" },
    });
    const res = await agentMemoryRememberHandler(
      { text: "A surprising trap", weight: "high" },
      CTX,
    );
    expect(mocks.generateObjectForMock).toHaveBeenCalledTimes(1);
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.kind).toBe("gotcha");
  });

  it("when weight is omitted, classifies and sets classified: true", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { kind: "bug-root-cause", weight: "critical" },
    });
    const res = await agentMemoryRememberHandler(
      { text: "Root cause discovered", kind: "bug-root-cause" },
      CTX,
    );
    expect(mocks.generateObjectForMock).toHaveBeenCalledTimes(1);
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.weight).toBe("critical");
  });

  it("when both kind and weight are omitted, classifies and returns model values", async () => {
    mocks.generateObjectForMock.mockResolvedValueOnce({
      object: { kind: "convention-deviation", weight: "low" },
    });
    const res = await agentMemoryRememberHandler({ text: "Changed pattern" }, CTX);
    expect(res.inferred.classified).toBe(true);
    expect(res.inferred.kind).toBe("convention-deviation");
    expect(res.inferred.weight).toBe("low");
  });

  it("falls back to constraint/high and classified:false when generateObjectFor throws", async () => {
    mocks.generateObjectForMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    const res = await agentMemoryRememberHandler({ text: "A lesson" }, CTX);
    expect(res.inferred.classified).toBe(false);
    expect(res.inferred.kind).toBe("constraint");
    expect(res.inferred.weight).toBe("high");
    // writeMemory should still be called (graph is enabled) with the safe defaults.
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(1);
  });

  it("when graph is disabled, returns a sentinel record with empty id (no Neo4j or embed calls)", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);
    // Both kind and weight supplied so we can isolate the graph-disabled branch.
    const res = await agentMemoryRememberHandler(
      { text: "A lesson", kind: "routine-change", weight: "low" },
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
      { text: "Sentinel test", kind: "gotcha", weight: "critical" },
      CTX,
    );
    expect(typeof res.memory.createdAt).toBe("string");
    expect(res.memory.lastReinforcedAt).toBeNull();
    expect(res.memory.confidence).toBe(1);
  });

  it("uses the nodeRef from input when provided", async () => {
    await agentMemoryRememberHandler(
      { text: "Anchored lesson", kind: "constraint", weight: "high", nodeRef: "Function:auth#validate" },
      CTX,
    );
    const writeArg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(writeArg.nodeRef).toBe("Function:auth#validate");
  });

  it("defaults nodeRef to 'user-memory' when not supplied", async () => {
    await agentMemoryRememberHandler(
      { text: "Free-form note", kind: "constraint", weight: "high" },
      CTX,
    );
    const writeArg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(writeArg.nodeRef).toBe("user-memory");
  });

  it("returns the record from getMemoryById as the memory field", async () => {
    const res = await agentMemoryRememberHandler(
      { text: "A lesson", kind: "constraint", weight: "high" },
      CTX,
    );
    expect(res.memory).toEqual(PERSISTED_RECORD);
  });

  it("falls back to a constructed record when getMemoryById returns null", async () => {
    mocks.getMemoryByIdMock.mockResolvedValueOnce(null);
    const res = await agentMemoryRememberHandler(
      { text: "A lesson", kind: "gotcha", weight: "high" },
      CTX,
    );
    // Falls back to the constructed record — id equals memoryId from writeMemory
    expect(res.memory.id).toBe("m_new");
    expect(res.memory.lesson).toBe("A lesson");
  });
});
