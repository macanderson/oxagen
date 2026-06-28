import { describe, expect, it } from "vitest";
import { agentMemoryList } from "./agent.memory.list";
import { getCapability } from "../registry";

describe("agent.memory.list capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentMemoryList.input.parse({});
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
    expect(parsed.nodeRef).toBeUndefined();
    expect(parsed.minWeight).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
  });

  it("accepts the optional filters", () => {
    const parsed = agentMemoryList.input.parse({
      nodeRef: "user:mac-anderson",
      minWeight: "critical",
      kind: "gotcha",
      limit: 25,
      offset: 50,
    });
    expect(parsed.minWeight).toBe("critical");
    expect(parsed.kind).toBe("gotcha");
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(50);
  });

  it("rejects a limit above the cap", () => {
    expect(() => agentMemoryList.input.parse({ limit: 201 })).toThrow();
  });

  it("rejects a negative offset", () => {
    expect(() => agentMemoryList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects an unknown weight and an unknown kind", () => {
    expect(() => agentMemoryList.input.parse({ minWeight: "medium" })).toThrow();
    expect(() => agentMemoryList.input.parse({ kind: "note" })).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMemoryList.output.parse({
      memories: [
        {
          id: "mem_1",
          publicId: "pub_1",
          nodeRef: "user:mac-anderson",
          weight: "high",
          kind: "constraint",
          lesson: "The user's name is Mac Anderson.",
          source: "feature",
          confidence: 1,
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
    expect(getCapability("agent.memory.list")).toBe(agentMemoryList);
  });
});
