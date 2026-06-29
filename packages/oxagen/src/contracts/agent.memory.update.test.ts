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
    expect(parsed.lesson).toBe("Always use batch inserts for high-volume writes");
    expect(parsed.weight).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });

  it("parses a valid input with all optional fields", () => {
    const parsed = agentMemoryUpdate.input.parse({
      memoryId: "mem_1",
      lesson: "New lesson",
      weight: "critical",
      kind: "gotcha",
      source: "fix",
      confidence: 0.8,
    });
    expect(parsed.weight).toBe("critical");
    expect(parsed.kind).toBe("gotcha");
    expect(parsed.source).toBe("fix");
    expect(parsed.confidence).toBe(0.8);
  });

  it("accepts each individual optional field on its own", () => {
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", weight: "low" }).weight).toBe("low");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", weight: "high" }).weight).toBe("high");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", kind: "constraint" }).kind).toBe("constraint");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", kind: "routine-change" }).kind).toBe("routine-change");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", kind: "bug-root-cause" }).kind).toBe("bug-root-cause");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", kind: "convention-deviation" }).kind).toBe("convention-deviation");
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", source: "user" }).source).toBe("user");
  });

  it("rejects an empty memoryId", () => {
    expect(() => agentMemoryUpdate.input.parse({ memoryId: "" })).toThrow();
  });

  it("rejects an invalid weight", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", weight: "medium" }),
    ).toThrow();
  });

  it("rejects an invalid kind", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", kind: "note" }),
    ).toThrow();
  });

  it("rejects confidence below 0", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", confidence: -0.1 }),
    ).toThrow();
  });

  it("rejects confidence above 1", () => {
    expect(() =>
      agentMemoryUpdate.input.parse({ memoryId: "m", confidence: 1.1 }),
    ).toThrow();
  });

  it("accepts confidence at the boundary values 0 and 1", () => {
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", confidence: 0 }).confidence).toBe(0);
    expect(agentMemoryUpdate.input.parse({ memoryId: "m", confidence: 1 }).confidence).toBe(1);
  });

  it("output schema accepts a full agentMemoryRecord", () => {
    const parsed = agentMemoryUpdate.output.parse({
      id: "mem_1",
      publicId: "pub_1",
      nodeRef: "Function:foo",
      weight: "high",
      kind: "constraint",
      lesson: "Always check the constraint.",
      source: "feature",
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      lastReinforcedAt: null,
    });
    expect(parsed.id).toBe("mem_1");
    expect(parsed.weight).toBe("high");
    expect(parsed.lastReinforcedAt).toBeNull();
  });

  it("is registered under name 'agent.memory.update'", () => {
    expect(getCapability("agent.memory.update")).toBe(agentMemoryUpdate);
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
