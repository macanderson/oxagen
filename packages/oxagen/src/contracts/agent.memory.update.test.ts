import { describe, expect, it } from "vitest";
import { agentMemoryUpdate } from "./agent.memory.update";
import { getCapability } from "../registry";

describe("agent.memory.update capability", () => {
  it("parses a valid input with only memoryId and lesson", () => {
    const parsed = agentMemoryUpdate.input.parse({
      memoryId: "mem_1",
      lesson: "Always use batch inserts for high-volume writes",
    });
    expect(parsed.memoryId).toBe("mem_1");
    expect(parsed.lesson).toBe(
      "Always use batch inserts for high-volume writes",
    );
    expect(parsed.memoryKind).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.confidenceScore).toBeUndefined();
    expect(parsed.enforcementScore).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it("parses a valid input with all optional fields", () => {
    const parsed = agentMemoryUpdate.input.parse({
      memoryId: "mem_1",
      lesson: "New lesson",
      memoryKind: "gotcha",
      source: "fix",
      confidenceScore: 80,
      enforcementScore: 60,
      status: "ARCHIVED",
    });
    expect(parsed.memoryKind).toBe("gotcha");
    expect(parsed.source).toBe("fix");
    expect(parsed.confidenceScore).toBe(80);
    expect(parsed.enforcementScore).toBe(60);
    expect(parsed.status).toBe("ARCHIVED");
  });

  it("accepts each individual optional field on its own", () => {
    expect(
      agentMemoryUpdate.input.parse({ memoryId: "m", memoryKind: "constraint" })
        .memoryKind,
    ).toBe("constraint");
    expect(
      agentMemoryUpdate.input.parse({
        memoryId: "m",
        memoryKind: "routine-change",
      }).memoryKind,
    ).toBe("routine-change");
    expect(
      agentMemoryUpdate.input.parse({
        memoryId: "m",
        memoryKind: "bug-root-cause",
      }).memoryKind,
    ).toBe("bug-root-cause");
    expect(
      agentMemoryUpdate.input.parse({
        memoryId: "m",
        memoryKind: "convention-deviation",
      }).memoryKind,
    ).toBe("convention-deviation");
    expect(
      agentMemoryUpdate.input.parse({ memoryId: "m", source: "user" }).source,
    ).toBe("user");
    expect(
      agentMemoryUpdate.input.parse({ memoryId: "m", status: "RETRACTED" })
        .status,
    ).toBe("RETRACTED");
  });

  it("rejects an empty memoryId", () => {
    expect(() => agentMemoryUpdate.input.parse({ memoryId: "" })).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", status: "DELETED" }),
    ).toThrow();
  });

  it("rejects confidenceScore below 0", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", confidenceScore: -1 }),
    ).toThrow();
  });

  it("rejects confidenceScore above 100", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", confidenceScore: 101 }),
    ).toThrow();
  });

  it("accepts confidenceScore at the boundary values 0 and 100", () => {
    expect(
      agentMemoryUpdate.input.parse({ memoryId: "m", confidenceScore: 0 })
        .confidenceScore,
    ).toBe(0);
    expect(
      agentMemoryUpdate.input.parse({ memoryId: "m", confidenceScore: 100 })
        .confidenceScore,
    ).toBe(100);
  });

  it("rejects an enforcementScore out of the 1-100 range", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", enforcementScore: 0 }),
    ).toThrow();
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", enforcementScore: 101 }),
    ).toThrow();
  });

  it("output schema accepts a full agentMemoryRecord", () => {
    const parsed = agentMemoryUpdate.output.parse({
      id: "mem_1",
      publicId: "pub_1",
      nodeRef: "Function:foo",
      memoryClass: "RULE",
      memoryKind: "constraint",
      lesson: "Always check the constraint.",
      source: "feature",
      confidenceScore: 90,
      enforcementScore: 70,
      status: "ACTIVE",
      subjectHint: "Function:foo",
      halfLifeDays: 90,
      decayFloor: 5,
      lastEvidenceAt: new Date().toISOString(),
      citationCount: 0,
      influenceCount: 0,
      violationCount: 0,
      createdByKind: "AGENT",
      createdById: "feature",
      confirmedByKind: null,
      confirmedById: null,
      createdAt: new Date().toISOString(),
      lastReinforcedAt: null,
    });
    expect(parsed.id).toBe("mem_1");
    expect(parsed.memoryClass).toBe("RULE");
    expect(parsed.enforcementScore).toBe(70);
    expect(parsed.lastReinforcedAt).toBeNull();
  });

  it("is registered under name 'update_memory'", () => {
    expect(getCapability("update_memory")).toBe(agentMemoryUpdate);
  });

  it("is scoped", () => {
    expect(agentMemoryUpdate.scoped).toBe(true);
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(agentMemoryUpdate.surfaces).toContain("api");
    expect(agentMemoryUpdate.surfaces).toContain("mcp");
    expect(agentMemoryUpdate.surfaces).toContain("agent");
  });

  it("agent.requiresApproval is false", () => {
    expect(agentMemoryUpdate.agent?.requiresApproval).toBe(false);
  });
});
