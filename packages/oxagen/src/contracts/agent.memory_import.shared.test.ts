import { describe, expect, it } from "vitest";
import {
  memoryImportDraftSchema,
  memoryClassEnum,
} from "./agent.memory_import.shared";

describe("memoryImportDraftSchema", () => {
  it("applies provenance/classification defaults from just {lesson, memoryKind}", () => {
    const parsed = memoryImportDraftSchema.parse({
      lesson: "Never push to main.",
      memoryKind: "constraint",
    });
    expect(parsed.memoryClass).toBe("OBSERVATION");
    expect(parsed.source).toBe("user");
    expect(parsed.nodeRef).toBe("user-memory");
    expect(parsed.sourceDocument).toBe("");
    expect(parsed.classified).toBe(false);
  });

  it("preserves explicitly-supplied provenance and classification fields", () => {
    const parsed = memoryImportDraftSchema.parse({
      lesson: "Anchored lesson.",
      memoryClass: "RULE",
      memoryKind: "gotcha",
      enforcementScore: 80,
      source: "imported-rules",
      nodeRef: "Function:auth#login",
      sourceDocument: "auth-rules.md",
      classified: true,
    });
    expect(parsed.memoryClass).toBe("RULE");
    expect(parsed.enforcementScore).toBe(80);
    expect(parsed.source).toBe("imported-rules");
    expect(parsed.nodeRef).toBe("Function:auth#login");
    expect(parsed.sourceDocument).toBe("auth-rules.md");
    expect(parsed.classified).toBe(true);
  });

  it("rejects an empty lesson", () => {
    expect(() =>
      memoryImportDraftSchema.parse({ lesson: "", memoryKind: "constraint" }),
    ).toThrow();
  });

  it("rejects a lesson over 2000 characters", () => {
    expect(() =>
      memoryImportDraftSchema.parse({
        lesson: "x".repeat(2001),
        memoryKind: "constraint",
      }),
    ).toThrow();
  });

  it("rejects a missing memoryKind (no default — the extractor must always classify it)", () => {
    expect(() => memoryImportDraftSchema.parse({ lesson: "L" })).toThrow();
  });

  it("rejects an unknown memoryClass", () => {
    expect(() =>
      memoryImportDraftSchema.parse({
        lesson: "L",
        memoryClass: "MAYBE",
        memoryKind: "constraint",
      }),
    ).toThrow();
  });

  it("rejects an enforcementScore out of the 1-100 range", () => {
    expect(() =>
      memoryImportDraftSchema.parse({
        lesson: "L",
        memoryClass: "RULE",
        memoryKind: "constraint",
        enforcementScore: 0,
      }),
    ).toThrow();
    expect(() =>
      memoryImportDraftSchema.parse({
        lesson: "L",
        memoryClass: "RULE",
        memoryKind: "constraint",
        enforcementScore: 101,
      }),
    ).toThrow();
  });

  it("mirrors the shared two-axis memory class taxonomy", () => {
    expect(memoryClassEnum.options).toEqual(["OBSERVATION", "RULE", "FACT"]);
  });
});
