import { describe, expect, it } from "vitest";
import {
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  MEMORY_KINDS,
  MEMORY_WEIGHTS,
  type MemoryRecord,
  type MemoryListResult,
  type RememberResult,
} from "../memory-client.js";

const REC: MemoryRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  publicId: "pub_abc",
  nodeRef: "Function:auth#validate",
  weight: "high",
  kind: "constraint",
  lesson: "Always validate the session cookie prefix in production.",
  source: "user",
  confidence: 0.87,
  createdAt: "2026-06-28T00:00:00Z",
  lastReinforcedAt: null,
};

describe("memory-client constants", () => {
  it("exposes the five kinds and three weights the contract defines", () => {
    expect(MEMORY_KINDS).toEqual([
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ]);
    expect(MEMORY_WEIGHTS).toEqual(["low", "high", "critical"]);
  });
});

describe("formatMemoryLines", () => {
  it("renders an empty-state hint when there are no memories", () => {
    const result: MemoryListResult = { memories: [], total: 0 };
    expect(formatMemoryLines(result)).toContain("No memories yet");
  });

  it("renders a header, the short id, weight/kind, confidence, and a truncated lesson", () => {
    const out = formatMemoryLines({ memories: [REC], total: 1 });
    expect(out).toContain("weight/kind");
    expect(out).toContain("11111111"); // short id (first 8 chars)
    expect(out).toContain("high/constraint");
    expect(out).toContain("0.87");
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
});

describe("formatMemoryDetail", () => {
  it("renders every field of the record", () => {
    const out = formatMemoryDetail(REC);
    expect(out).toContain(`Memory ${REC.id}`);
    expect(out).toContain(REC.lesson);
    expect(out).toContain("kind:       constraint");
    expect(out).toContain("weight:     high");
    expect(out).toContain("confidence: 0.87");
    expect(out).toContain("source:     user");
    expect(out).toContain("Function:auth#validate");
    expect(out).toContain("publicId:   pub_abc");
  });

  it("shows (none) for a missing nodeRef and (never) for a null reinforcement", () => {
    const out = formatMemoryDetail({ ...REC, nodeRef: "", lastReinforcedAt: null });
    expect(out).toContain("nodeRef:    (none)");
    expect(out).toContain("reinforced: (never)");
  });
});

describe("formatRememberResult", () => {
  it("reports inferred kind/weight when the model classified", () => {
    const r: RememberResult = {
      memory: REC,
      inferred: { kind: "constraint", weight: "high", classified: true },
    };
    const out = formatRememberResult(r);
    expect(out).toContain("✓ Remembered");
    expect(out).toContain("kind constraint");
    expect(out).toContain("weight high");
    expect(out).toContain("(inferred)");
    expect(out).toContain(REC.id);
  });

  it("reports 'set' rather than 'inferred' when the caller pinned the values", () => {
    const r: RememberResult = {
      memory: REC,
      inferred: { kind: "gotcha", weight: "critical", classified: false },
    };
    expect(formatRememberResult(r)).toContain("(set)");
  });
});
