import { describe, expect, it } from "vitest";
import { agentMemoryRemember } from "./agent.memory.remember";
import { getCapability } from "../registry";

const VALID_RECORD = {
  id: "mem_1",
  publicId: "pub_1",
  nodeRef: "user-memory",
  weight: "high" as const,
  kind: "constraint",
  lesson: "A lesson the agent must respect.",
  source: "user",
  confidence: 1,
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
    expect(parsed.weight).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
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
      weight: "critical",
      kind: "gotcha",
      source: "fix",
      relatedNodeIds: ["kn_1", "kn_2"],
    });
    expect(parsed.nodeRef).toBe("Function:auth#validate");
    expect(parsed.weight).toBe("critical");
    expect(parsed.kind).toBe("gotcha");
    expect(parsed.source).toBe("fix");
    expect(parsed.relatedNodeIds).toEqual(["kn_1", "kn_2"]);
  });

  it("accepts all valid weight values", () => {
    expect(agentMemoryRemember.input.parse({ text: "x", weight: "low" }).weight).toBe("low");
    expect(agentMemoryRemember.input.parse({ text: "x", weight: "high" }).weight).toBe("high");
    expect(agentMemoryRemember.input.parse({ text: "x", weight: "critical" }).weight).toBe("critical");
  });

  it("accepts all valid kind values", () => {
    for (const kind of [
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ] as const) {
      expect(agentMemoryRemember.input.parse({ text: "x", kind }).kind).toBe(kind);
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

  it("rejects an invalid weight", () => {
    expect(() =>
      agentMemoryRemember.input.parse({ text: "hi", weight: "medium" }),
    ).toThrow();
  });

  it("rejects an invalid kind", () => {
    expect(() =>
      agentMemoryRemember.input.parse({ text: "hi", kind: "note" }),
    ).toThrow();
  });

  it("output parses a valid record with classified:true", () => {
    const parsed = agentMemoryRemember.output.parse({
      memory: VALID_RECORD,
      inferred: { kind: "constraint", weight: "high", classified: true },
    });
    expect(parsed.inferred.classified).toBe(true);
    expect(parsed.inferred.kind).toBe("constraint");
    expect(parsed.inferred.weight).toBe("high");
    expect(parsed.memory.id).toBe("mem_1");
  });

  it("output parses a valid record with classified:false (caller pinned values)", () => {
    const parsed = agentMemoryRemember.output.parse({
      memory: { ...VALID_RECORD, kind: "gotcha", weight: "low" },
      inferred: { kind: "gotcha", weight: "low", classified: false },
    });
    expect(parsed.inferred.classified).toBe(false);
    expect(parsed.inferred.kind).toBe("gotcha");
    expect(parsed.inferred.weight).toBe("low");
  });

  it("is registered under name 'agent.memory.remember'", () => {
    expect(getCapability("agent.memory.remember")).toBe(agentMemoryRemember);
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
