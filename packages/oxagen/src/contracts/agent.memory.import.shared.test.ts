import { describe, expect, it } from "vitest";
import {
  memoryImportDraftSchema,
  memoryKindEnum,
  memoryWeightEnum,
} from "./agent.memory.import.shared";

describe("memoryImportDraftSchema", () => {
  it("applies provenance/classification defaults from just {lesson, kind, weight}", () => {
    const parsed = memoryImportDraftSchema.parse({
      lesson: "Never push to main.",
      kind: "constraint",
      weight: "critical",
    });
    expect(parsed.source).toBe("user");
    expect(parsed.nodeRef).toBe("user-memory");
    expect(parsed.sourceDocument).toBe("");
    expect(parsed.classified).toBe(false);
  });

  it("preserves explicitly-supplied provenance fields", () => {
    const parsed = memoryImportDraftSchema.parse({
      lesson: "Anchored lesson.",
      kind: "gotcha",
      weight: "low",
      source: "imported-rules",
      nodeRef: "Function:auth#login",
      sourceDocument: "auth-rules.md",
      classified: true,
    });
    expect(parsed.source).toBe("imported-rules");
    expect(parsed.nodeRef).toBe("Function:auth#login");
    expect(parsed.sourceDocument).toBe("auth-rules.md");
    expect(parsed.classified).toBe(true);
  });

  it("rejects an empty lesson", () => {
    expect(() =>
      memoryImportDraftSchema.parse({ lesson: "", kind: "constraint", weight: "high" }),
    ).toThrow();
  });

  it("rejects a lesson over 2000 characters", () => {
    expect(() =>
      memoryImportDraftSchema.parse({
        lesson: "x".repeat(2001),
        kind: "constraint",
        weight: "high",
      }),
    ).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      memoryImportDraftSchema.parse({ lesson: "L", kind: "not-a-kind", weight: "high" }),
    ).toThrow();
  });

  it("rejects an unknown weight", () => {
    expect(() =>
      memoryImportDraftSchema.parse({ lesson: "L", kind: "constraint", weight: "huge" }),
    ).toThrow();
  });

  it("mirrors the closed AgentMemory taxonomy", () => {
    expect(memoryKindEnum.options).toEqual([
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ]);
    expect(memoryWeightEnum.options).toEqual(["low", "high", "critical"]);
  });
});
