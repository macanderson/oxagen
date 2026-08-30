import { describe, expect, it } from "vitest";
import { agentMemoryList } from "./agent.memory.list";
import { getCapability } from "../registry";

describe("agent.memory.list capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentMemoryList.input.parse({});
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
    expect(parsed.nodeRef).toBeUndefined();
    expect(parsed.memoryClass).toBeUndefined();
    expect(parsed.memoryKind).toBeUndefined();
    expect(parsed.minEnforcement).toBeUndefined();
    expect(parsed.minCitations).toBeUndefined();
    // Sort defaults to recency, descending — unchanged legacy behaviour.
    expect(parsed.sort).toBe("createdAt");
    expect(parsed.sortDir).toBe("desc");
  });

  it("accepts the optional filters", () => {
    const parsed = agentMemoryList.input.parse({
      nodeRef: "user:mac-anderson",
      memoryClass: "RULE",
      memoryKind: "gotcha",
      minEnforcement: 50,
      minCitations: 3,
      sort: "citationCount",
      sortDir: "asc",
      limit: 25,
      offset: 50,
    });
    expect(parsed.memoryClass).toBe("RULE");
    expect(parsed.memoryKind).toBe("gotcha");
    expect(parsed.minEnforcement).toBe(50);
    expect(parsed.minCitations).toBe(3);
    expect(parsed.sort).toBe("citationCount");
    expect(parsed.sortDir).toBe("asc");
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(50);
  });

  it("rejects a negative minCitations and an unknown sort axis", () => {
    expect(() => agentMemoryList.input.parse({ minCitations: -1 })).toThrow();
    expect(() => agentMemoryList.input.parse({ sort: "sideways" })).toThrow();
  });

  it("rejects a limit above the cap", () => {
    expect(() => agentMemoryList.input.parse({ limit: 201 })).toThrow();
  });

  it("rejects a negative offset", () => {
    expect(() => agentMemoryList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects an unknown memoryClass", () => {
    expect(() =>
      agentMemoryList.input.parse({ memoryClass: "MAYBE" }),
    ).toThrow();
  });

  it("rejects a minEnforcement out of the 1-100 range", () => {
    expect(() => agentMemoryList.input.parse({ minEnforcement: 0 })).toThrow();
    expect(() =>
      agentMemoryList.input.parse({ minEnforcement: 101 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMemoryList.output.parse({
      memories: [
        {
          id: "mem_1",
          publicId: "pub_1",
          nodeRef: "user:mac-anderson",
          memoryClass: "OBSERVATION",
          memoryKind: "constraint",
          lesson: "The user's name is Mac Anderson.",
          source: "feature",
          confidenceScore: 100,
          enforcementScore: null,
          status: "ACTIVE",
          subjectHint: "user:mac-anderson",
          halfLifeDays: 30,
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
        },
      ],
      total: 1,
    });
    expect(parsed.total).toBe(1);
    expect(parsed.memories[0]?.nodeRef).toBe("user:mac-anderson");
    expect(parsed.memories[0]?.lastReinforcedAt).toBeNull();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_memories")).toBe(agentMemoryList);
  });
});
