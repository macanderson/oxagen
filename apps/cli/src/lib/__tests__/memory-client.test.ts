import { describe, expect, it } from "vitest";
import {
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  formatPromoteResult,
  formatPromotionCandidates,
  RECOMMENDED_MEMORY_KINDS,
  MEMORY_CLASSES,
  type MemoryRecord,
  type MemoryListResult,
  type RememberResult,
  type PromotionCandidatesResult,
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
    const observation: MemoryRecord = { ...REC, memoryClass: "OBSERVATION", enforcementScore: null };
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
      inferred: { memoryClass: "RULE", memoryKind: "constraint", classified: true },
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
      inferred: { memoryClass: "OBSERVATION", memoryKind: "gotcha", classified: false },
    };
    expect(formatRememberResult(r)).toContain("(set)");
  });
});

describe("formatPromoteResult", () => {
  it("reports the new class and enforcement", () => {
    const promoted: MemoryRecord = { ...REC, memoryClass: "FACT", enforcementScore: 100 };
    const out = formatPromoteResult(promoted);
    expect(out).toContain("✓ Promoted to FACT");
    expect(out).toContain("enforcement 100");
    expect(out).toContain(promoted.id);
  });
});

describe("formatPromotionCandidates", () => {
  it("renders an empty-state hint when there are no candidates", () => {
    const result: PromotionCandidatesResult = { candidates: [] };
    expect(formatPromotionCandidates(result)).toContain("No promotion candidates");
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
