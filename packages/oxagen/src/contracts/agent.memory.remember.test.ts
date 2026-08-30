import { describe, expect, it } from "vitest";
import { agentMemoryRemember } from "./agent.memory.remember";
import { getCapability } from "../registry";

const VALID_RECORD = {
  id: "mem_1",
  publicId: "pub_1",
  nodeRef: "user-memory",
  memoryClass: "OBSERVATION" as const,
  memoryKind: "constraint",
  lesson: "A lesson the agent must respect.",
  source: "user",
  confidenceScore: 100,
  enforcementScore: null,
  status: "ACTIVE" as const,
  subjectHint: "user-memory",
  halfLifeDays: 30,
  decayFloor: 5,
  lastEvidenceAt: new Date().toISOString(),
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "USER" as const,
  createdById: "user",
  confirmedByKind: null,
  confirmedById: null,
  createdAt: new Date().toISOString(),
  lastReinforcedAt: null,
};

describe("agent.memory.remember capability", () => {
  it("parses valid input with only text and applies source default", () => {
    const parsed = agentMemoryRemember.input.parse({
      text: "Always check auth before mutating data",
    });
    expect(parsed.text).toBe("Always check auth before mutating data");
    // source defaults to "user" when omitted
    expect(parsed.source).toBe("user");
    expect(parsed.memoryClass).toBeUndefined();
    expect(parsed.memoryKind).toBeUndefined();
    expect(parsed.nodeRef).toBeUndefined();
    expect(parsed.relatedNodeIds).toBeUndefined();
  });

  it("source defaults to 'user' when omitted", () => {
    const parsed = agentMemoryRemember.input.parse({ text: "A lesson" });
    expect(parsed.source).toBe("user");
  });

  it("accepts all optional fields", () => {
    const parsed = agentMemoryRemember.input.parse({
      text: "A lesson about auth",
      nodeRef: "Function:auth#validate",
      memoryClass: "RULE",
      memoryKind: "gotcha",
      enforcementScore: 75,
      source: "fix",
      relatedNodeIds: ["kn_1", "kn_2"],
    });
    expect(parsed.nodeRef).toBe("Function:auth#validate");
    expect(parsed.memoryClass).toBe("RULE");
    expect(parsed.memoryKind).toBe("gotcha");
    expect(parsed.enforcementScore).toBe(75);
    expect(parsed.source).toBe("fix");
    expect(parsed.relatedNodeIds).toEqual(["kn_1", "kn_2"]);
  });

  it("accepts all valid memoryClass values", () => {
    expect(
      agentMemoryRemember.input.parse({ text: "x", memoryClass: "OBSERVATION" })
        .memoryClass,
    ).toBe("OBSERVATION");
    expect(
      agentMemoryRemember.input.parse({ text: "x", memoryClass: "RULE" })
        .memoryClass,
    ).toBe("RULE");
    expect(
      agentMemoryRemember.input.parse({ text: "x", memoryClass: "FACT" })
        .memoryClass,
    ).toBe("FACT");
  });

  it("accepts an open-string memoryKind, including the canonical values", () => {
    for (const memoryKind of [
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
      "FEEDBACK",
      "PREFERENCE",
    ]) {
      expect(
        agentMemoryRemember.input.parse({ text: "x", memoryKind }).memoryKind,
      ).toBe(memoryKind);
    }
  });

  it("rejects an empty text", () => {
    expect(() => agentMemoryRemember.input.parse({ text: "" })).toThrow();
  });

  it("rejects text above 2000 characters", () => {
    expect(() =>
      agentMemoryRemember.input.parse({ text: "x".repeat(2001) }),
    ).toThrow();
  });

  it("accepts text of exactly 2000 characters", () => {
    const parsed = agentMemoryRemember.input.parse({ text: "x".repeat(2000) });
    expect(parsed.text).toHaveLength(2000);
  });

  it("rejects an invalid memoryClass", () => {
    expect(() =>
      agentMemoryRemember.input.parse({ text: "hi", memoryClass: "MAYBE" }),
    ).toThrow();
  });

  it("rejects an enforcementScore out of the 1-100 range", () => {
    expect(() =>
      agentMemoryRemember.input.parse({ text: "hi", enforcementScore: 0 }),
    ).toThrow();
    expect(() =>
      agentMemoryRemember.input.parse({ text: "hi", enforcementScore: 101 }),
    ).toThrow();
  });

  it("output parses a valid record with classified:true", () => {
    const parsed = agentMemoryRemember.output.parse({
      memory: VALID_RECORD,
      inferred: {
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        classified: true,
      },
    });
    expect(parsed.inferred.classified).toBe(true);
    expect(parsed.inferred.memoryClass).toBe("OBSERVATION");
    expect(parsed.inferred.memoryKind).toBe("constraint");
    expect(parsed.memory.id).toBe("mem_1");
  });

  it("output parses a valid record with classified:false (caller pinned values)", () => {
    const parsed = agentMemoryRemember.output.parse({
      memory: {
        ...VALID_RECORD,
        memoryClass: "RULE",
        memoryKind: "gotcha",
        enforcementScore: 80,
      },
      inferred: {
        memoryClass: "RULE",
        memoryKind: "gotcha",
        classified: false,
      },
    });
    expect(parsed.inferred.classified).toBe(false);
    expect(parsed.inferred.memoryClass).toBe("RULE");
    expect(parsed.inferred.memoryKind).toBe("gotcha");
  });

  it("is registered under name 'save_memory'", () => {
    expect(getCapability("save_memory")).toBe(agentMemoryRemember);
  });

  it("is scoped", () => {
    expect(agentMemoryRemember.scoped).toBe(true);
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(agentMemoryRemember.surfaces).toContain("api");
    expect(agentMemoryRemember.surfaces).toContain("mcp");
    expect(agentMemoryRemember.surfaces).toContain("agent");
  });

  it("agent.requiresApproval is false", () => {
    expect(agentMemoryRemember.agent?.requiresApproval).toBe(false);
  });
});
