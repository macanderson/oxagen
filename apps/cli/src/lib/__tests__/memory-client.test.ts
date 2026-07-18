import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the transport so listMemories()'s request body can be asserted without
// hitting the network. Hoisted above the import of memory-client.
const { apiPostOrThrow } = vi.hoisted(() => ({ apiPostOrThrow: vi.fn() }));
vi.mock("../api.js", () => ({ apiPostOrThrow }));

import {
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  formatPromoteResult,
  formatDemoteResult,
  formatDismissResult,
  formatCitationStats,
  formatPromotionCandidates,
  listMemories,
  demoteMemory,
  dismissPromotion,
  citationStats,
  RECOMMENDED_MEMORY_KINDS,
  MEMORY_CLASSES,
  type MemoryRecord,
  type MemoryListResult,
  type RememberResult,
  type PromotionCandidatesResult,
  type DismissPromotionResult,
  type CitationStatsResult,
} from "../memory-client.js";

const REC: MemoryRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  publicId: "pub_abc",
  nodeRef: "Function:auth#validate",
  memoryClass: "RULE",
  memoryKind: "constraint",
  lesson: "Always validate the session cookie prefix in production.",
  source: "user",
  confidenceScore: 87,
  enforcementScore: 70,
  status: "ACTIVE",
  subjectHint: "auth#validate",
  halfLifeDays: 90,
  decayFloor: 5,
  lastEvidenceAt: "2026-06-27T00:00:00Z",
  citationCount: 3,
  influenceCount: 2,
  violationCount: 0,
  createdByKind: "USER",
  createdById: "user_1",
  confirmedByKind: null,
  confirmedById: null,
  createdAt: "2026-06-28T00:00:00Z",
  lastReinforcedAt: null,
};

describe("listMemories transport", () => {
  beforeEach(() => {
    apiPostOrThrow.mockReset();
    apiPostOrThrow.mockResolvedValue({ memories: [], total: 0 });
  });

  it("forwards the citation sort axis and minCitations floor in the request body", async () => {
    await listMemories({
      minCitations: 3,
      sort: "citationCount",
      sortDir: "desc",
    });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/list",
      expect.objectContaining({
        minCitations: 3,
        sort: "citationCount",
        sortDir: "desc",
      }),
    );
  });

  it("defaults limit/offset and leaves sort undefined when unset", async () => {
    await listMemories();
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/list",
      expect.objectContaining({ limit: 100, offset: 0, sort: undefined }),
    );
  });
});

describe("demoteMemory transport", () => {
  beforeEach(() => {
    apiPostOrThrow.mockReset();
    apiPostOrThrow.mockResolvedValue(REC);
  });

  it("forwards the memoryId, target class, and rationale in the request body", async () => {
    await demoteMemory({
      memoryId: "m_1",
      toClass: "OBSERVATION",
      rationale: "no longer holds",
    });
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/demote", {
      memoryId: "m_1",
      toClass: "OBSERVATION",
      rationale: "no longer holds",
    });
  });

  it("unwraps the response to the updated memory record", async () => {
    const result = await demoteMemory({ memoryId: "m_1", toClass: "RULE" });
    expect(result).toBe(REC);
  });
});

describe("dismissPromotion transport", () => {
  beforeEach(() => {
    apiPostOrThrow.mockReset();
    apiPostOrThrow.mockResolvedValue({ memoryId: "m_1", dismissed: true });
  });

  it("defaults restore to false when omitted", async () => {
    await dismissPromotion({ memoryId: "m_1" });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/dismiss",
      { memoryId: "m_1", restore: false },
    );
  });

  it("forwards an explicit restore flag and unwraps the result", async () => {
    apiPostOrThrow.mockResolvedValueOnce({ memoryId: "m_1", dismissed: false });
    const result = await dismissPromotion({ memoryId: "m_1", restore: true });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/dismiss",
      { memoryId: "m_1", restore: true },
    );
    expect(result).toEqual({ memoryId: "m_1", dismissed: false });
  });
});

describe("citationStats transport", () => {
  beforeEach(() => {
    apiPostOrThrow.mockReset();
  });

  it("defaults days to 30 and limit to 10 when unset", async () => {
    apiPostOrThrow.mockResolvedValueOnce({
      totals: { citations: 0, executions: 0, memoriesCited: 0, nodesCited: 0 },
      byInfluence: {},
      byCompliance: {},
      daily: [],
      topMemories: [],
      leastUsefulMemories: [],
      mostViolatedRules: [],
      topNodes: [],
    });
    await citationStats();
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/citations/stats",
      {
        days: 30,
        limit: 10,
      },
    );
  });

  it("forwards explicit days/limit and unwraps the totals", async () => {
    const payload = {
      totals: { citations: 5, executions: 2, memoriesCited: 3, nodesCited: 1 },
      byInfluence: { DECISIVE: 2 },
      byCompliance: { COMPLIED: 3 },
      daily: [{ date: "2026-07-18", citations: 5, violations: 0 }],
      topMemories: [],
      leastUsefulMemories: [],
      mostViolatedRules: [],
      topNodes: [],
    };
    apiPostOrThrow.mockResolvedValueOnce(payload);
    const result = await citationStats({ days: 7, limit: 5 });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/citations/stats",
      {
        days: 7,
        limit: 5,
      },
    );
    expect(result).toEqual(payload);
  });
});

describe("memory-client constants", () => {
  it("exposes the recommended kinds and the three classes the contract defines", () => {
    expect(RECOMMENDED_MEMORY_KINDS).toEqual([
      "FEEDBACK",
      "PERFORMANCE",
      "STYLE",
      "PREFERENCE",
      "VOICE",
      "PROSE",
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ]);
    expect(MEMORY_CLASSES).toEqual(["OBSERVATION", "RULE", "FACT"]);
  });
});

describe("formatMemoryLines", () => {
  it("renders an empty-state hint when there are no memories", () => {
    const result: MemoryListResult = { memories: [], total: 0 };
    expect(formatMemoryLines(result)).toContain("No memories yet");
  });

  it("renders a header, the short id, class/kind, confidence, enforcement, and a truncated lesson", () => {
    const out = formatMemoryLines({ memories: [REC], total: 1 });
    expect(out).toContain("class/kind");
    expect(out).toContain("11111111"); // short id (first 8 chars)
    expect(out).toContain("RULE/constraint");
    expect(out).toContain("87.0");
    expect(out).toContain("70");
    expect(out).toContain("Always validate the session cookie prefix");
    expect(out).toContain("1 memory.");
  });

  it("shows a paging footer when total exceeds the page", () => {
    const out = formatMemoryLines({ memories: [REC], total: 42 });
    expect(out).toContain("Showing 1 of 42");
  });

  it("collapses whitespace and truncates long lessons with an ellipsis", () => {
    const long: MemoryRecord = {
      ...REC,
      lesson: "x".repeat(200),
    };
    const out = formatMemoryLines({ memories: [long], total: 1 });
    expect(out).toContain("…");
  });

  it("shows an em dash for a null enforcement score (OBSERVATION)", () => {
    const observation: MemoryRecord = {
      ...REC,
      memoryClass: "OBSERVATION",
      enforcementScore: null,
    };
    const out = formatMemoryLines({ memories: [observation], total: 1 });
    expect(out).toContain("—");
  });
});

describe("formatMemoryDetail", () => {
  it("renders every field of the record", () => {
    const out = formatMemoryDetail(REC);
    expect(out).toContain(`Memory ${REC.id}`);
    expect(out).toContain(REC.lesson);
    expect(out).toContain("memoryKind:  constraint");
    expect(out).toContain("memoryClass: RULE");
    expect(out).toContain("confidence:  87.0");
    expect(out).toContain("enforcement: 70");
    expect(out).toContain("status:      ACTIVE");
    expect(out).toContain("source:      user");
    expect(out).toContain("Function:auth#validate");
    expect(out).toContain("publicId:    pub_abc");
  });

  it("shows (none) for a missing nodeRef/subjectHint and null enforcement as an em dash", () => {
    const out = formatMemoryDetail({
      ...REC,
      nodeRef: "",
      subjectHint: "",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
    });
    expect(out).toContain("nodeRef:     (none)");
    expect(out).toContain("subjectHint: (none)");
    expect(out).toContain("enforcement: —");
  });
});

describe("formatRememberResult", () => {
  it("reports inferred class/kind when the model classified", () => {
    const r: RememberResult = {
      memory: REC,
      inferred: {
        memoryClass: "RULE",
        memoryKind: "constraint",
        classified: true,
      },
    };
    const out = formatRememberResult(r);
    expect(out).toContain("✓ Remembered");
    expect(out).toContain("class RULE");
    expect(out).toContain("kind constraint");
    expect(out).toContain("(inferred)");
    expect(out).toContain(REC.id);
  });

  it("reports 'set' rather than 'inferred' when the caller pinned the values", () => {
    const r: RememberResult = {
      memory: REC,
      inferred: {
        memoryClass: "OBSERVATION",
        memoryKind: "gotcha",
        classified: false,
      },
    };
    expect(formatRememberResult(r)).toContain("(set)");
  });
});

describe("formatPromoteResult", () => {
  it("reports the new class and enforcement", () => {
    const promoted: MemoryRecord = {
      ...REC,
      memoryClass: "FACT",
      enforcementScore: 100,
    };
    const out = formatPromoteResult(promoted);
    expect(out).toContain("✓ Promoted to FACT");
    expect(out).toContain("enforcement 100");
    expect(out).toContain(promoted.id);
  });
});

describe("formatDemoteResult", () => {
  it("reports the new (lower) class and enforcement", () => {
    const demoted: MemoryRecord = {
      ...REC,
      memoryClass: "OBSERVATION",
      enforcementScore: null,
    };
    const out = formatDemoteResult(demoted);
    expect(out).toContain("✓ Demoted to OBSERVATION");
    expect(out).toContain("enforcement —");
    expect(out).toContain(demoted.id);
  });
});

describe("formatDismissResult", () => {
  it("reports a dismissal", () => {
    const r: DismissPromotionResult = { memoryId: "m_1", dismissed: true };
    const out = formatDismissResult(r);
    expect(out).toContain("✓ Dismissed m_1");
    expect(out).toContain("from the promotion queue");
  });

  it("reports a restore when dismissed is false", () => {
    const r: DismissPromotionResult = { memoryId: "m_1", dismissed: false };
    const out = formatDismissResult(r);
    expect(out).toContain("✓ Restored m_1");
    expect(out).toContain("to the promotion queue");
  });
});

describe("formatCitationStats", () => {
  const EMPTY: CitationStatsResult = {
    totals: { citations: 0, executions: 0, memoriesCited: 0, nodesCited: 0 },
    byInfluence: {},
    byCompliance: {},
    daily: [],
    topMemories: [],
    leastUsefulMemories: [],
    mostViolatedRules: [],
    topNodes: [],
  };

  it("renders just the totals line when every breakdown/list is empty", () => {
    const out = formatCitationStats(EMPTY);
    expect(out).toContain("Citations: 0 across 0 executions");
    expect(out).not.toContain("influence:");
    expect(out).not.toContain("compliance:");
    expect(out).not.toContain("Most-cited memories:");
    expect(out).not.toContain("Least-useful");
    expect(out).not.toContain("Most-violated rules:");
    expect(out).not.toContain("Most-cited graph nodes:");
  });

  it("renders totals, breakdowns, and every memory/node section when populated", () => {
    const stat = {
      memoryId: "m_1",
      publicId: "pub_1",
      lesson: "Always validate the session cookie prefix in production.",
      memoryClass: "RULE" as const,
      memoryKind: "constraint",
      citationCount: 5,
      decisiveCount: 3,
      contributingCount: 1,
      consideredCount: 1,
      ignoredCount: 0,
      violationCount: 1,
    };
    const result: CitationStatsResult = {
      totals: { citations: 5, executions: 2, memoriesCited: 1, nodesCited: 1 },
      byInfluence: { DECISIVE: 3, CONTRIBUTING: 1 },
      byCompliance: { COMPLIED: 4, VIOLATION: 1 },
      daily: [{ date: "2026-07-18", citations: 5, violations: 1 }],
      topMemories: [stat],
      leastUsefulMemories: [stat],
      mostViolatedRules: [stat],
      topNodes: [
        {
          node: {
            id: "n_1",
            label: "Function",
            displayName: "auth#validate",
            properties: {},
          },
          citationCount: 5,
          decisiveCount: 3,
          ignoredCount: 0,
        },
      ],
    };
    const out = formatCitationStats(result);
    expect(out).toContain("Citations: 5 across 2 executions");
    expect(out).toContain("influence: DECISIVE 3, CONTRIBUTING 1");
    expect(out).toContain("compliance: COMPLIED 4, VIOLATION 1");
    expect(out).toContain("Most-cited memories:");
    expect(out).toContain("Least-useful (cited but never influential):");
    expect(out).toContain("Most-violated rules:");
    expect(out).toContain("Most-cited graph nodes:");
    expect(out).toContain("auth#validate [Function]");
  });
});

describe("formatPromotionCandidates", () => {
  it("renders an empty-state hint when there are no candidates", () => {
    const result: PromotionCandidatesResult = { candidates: [] };
    expect(formatPromotionCandidates(result)).toContain(
      "No promotion candidates",
    );
  });

  it("renders id, kind, citation/influence counts, and confidence", () => {
    const result: PromotionCandidatesResult = {
      candidates: [
        {
          id: "cccccccc-1111-2222-3333-444444444444",
          publicId: "pub_c1",
          lesson: "Repeatedly cited during login flows.",
          memoryKind: "constraint",
          citationCount: 12,
          influenceCount: 9,
          confidenceScore: 91.4,
        },
      ],
    };
    const out = formatPromotionCandidates(result);
    expect(out).toContain("cccccccc");
    expect(out).toContain("constraint");
    expect(out).toContain("12");
    expect(out).toContain("9");
    expect(out).toContain("91.4");
    expect(out).toContain("Repeatedly cited during login flows.");
  });
});
