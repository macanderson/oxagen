import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  generateObjectForMock,
  selectModelMock,
  getMemoryByIdMock,
  isKnowledgeGraphEnabledMock,
} = vi.hoisted(() => ({
  generateObjectForMock: vi.fn(),
  selectModelMock: vi.fn(() => "mock-model"),
  getMemoryByIdMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: generateObjectForMock,
  selectModel: selectModelMock,
}));
vi.mock("../memory/neo4j", () => ({ getMemoryById: getMemoryByIdMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryPromotionRationalesHandler } from "./agent.memory_promotion.rationales";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const MEMORY = {
  id: "m_1",
  publicId: "pub_1",
  nodeRef: "Function:foo",
  memoryClass: "OBSERVATION",
  memoryKind: "performance",
  lesson: "always batch database writes",
  source: "feature",
  confidenceScore: 88,
  enforcementScore: null,
  status: "ACTIVE",
  subjectHint: "Function:foo",
  halfLifeDays: 30,
  decayFloor: 5,
  lastEvidenceAt: null,
  citationCount: 7,
  influenceCount: 4,
  violationCount: 0,
  createdByKind: "AGENT",
  createdById: null,
  confirmedByKind: null,
  confirmedById: null,
  createdAt: "2026-07-01T00:00:00Z",
  lastReinforcedAt: null,
} as never;

beforeEach(() => {
  generateObjectForMock.mockReset();
  selectModelMock.mockClear();
  getMemoryByIdMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
});

describe("agent.memory.promotion.rationales handler", () => {
  it("throws when the knowledge graph is disabled", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);
    await expect(
      agentMemoryPromotionRationalesHandler(
        { memoryId: "m_1", toClass: "RULE", count: 4 },
        CTX,
      ),
    ).rejects.toThrow(/Knowledge graph is not configured/);
    expect(getMemoryByIdMock).not.toHaveBeenCalled();
  });

  it("throws a not-found error when the memory does not exist", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    getMemoryByIdMock.mockResolvedValueOnce(null);
    await expect(
      agentMemoryPromotionRationalesHandler(
        { memoryId: "missing", toClass: "RULE", count: 4 },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
    expect(generateObjectForMock).not.toHaveBeenCalled();
  });

  it("returns the model's rationales, clamped, deduped, and capped to count", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    getMemoryByIdMock.mockResolvedValueOnce(MEMORY);
    generateObjectForMock.mockResolvedValueOnce({
      object: {
        rationales: [
          "  Cited seven times with strong influence.  ",
          "Cited seven times with strong influence.", // duplicate after normalize
          "", // dropped
          "x".repeat(400), // over-long, clamped to 200
          "A third distinct rationale.",
        ],
      },
    });

    const out = await agentMemoryPromotionRationalesHandler(
      { memoryId: "m_1", toClass: "RULE", count: 2 },
      CTX,
    );

    expect(out.rationales).toEqual([
      "Cited seven times with strong influence.",
      "x".repeat(200),
    ]);
    expect(out.rationales.every((r) => r.length > 0 && r.length <= 200)).toBe(
      true,
    );
    expect(generateObjectForMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to deterministic rationales when the model call throws", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    getMemoryByIdMock.mockResolvedValueOnce(MEMORY);
    generateObjectForMock.mockRejectedValueOnce(new Error("gateway down"));

    const out = await agentMemoryPromotionRationalesHandler(
      { memoryId: "m_1", toClass: "RULE", count: 4 },
      CTX,
    );

    expect(out.rationales.length).toBeGreaterThanOrEqual(1);
    expect(out.rationales.every((r) => r.length > 0 && r.length <= 200)).toBe(
      true,
    );
    // Grounded in the memory's actual citation signals.
    expect(out.rationales.some((r) => r.includes("7"))).toBe(true);
  });

  it("falls back when the model returns only empty/blank rationales", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
    getMemoryByIdMock.mockResolvedValueOnce(MEMORY);
    generateObjectForMock.mockResolvedValueOnce({
      object: { rationales: ["", "   "] },
    });

    const out = await agentMemoryPromotionRationalesHandler(
      { memoryId: "m_1", toClass: "RULE", count: 3 },
      CTX,
    );

    expect(out.rationales.length).toBeGreaterThanOrEqual(1);
  });
});
