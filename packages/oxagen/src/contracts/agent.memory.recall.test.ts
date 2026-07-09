import { describe, expect, it } from "vitest";
import { agentMemoryRecall } from "./agent.memory.recall";
import { getCapability } from "../registry";

describe("agent.memory.recall capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentMemoryRecall.input.parse({ query: "auth" });
    expect(parsed.limit).toBe(10);
    expect(parsed.memoryClass).toBeUndefined();
    expect(parsed.minEnforcement).toBeUndefined();
  });

  it("rejects an empty query", () => {
    expect(() => agentMemoryRecall.input.parse({ query: "" })).toThrow();
  });

  it("rejects an unknown memoryClass", () => {
    expect(() =>
      agentMemoryRecall.input.parse({ query: "x", memoryClass: "MAYBE" }),
    ).toThrow();
  });

  it("rejects a minEnforcement out of the 1-100 range", () => {
    expect(() =>
      agentMemoryRecall.input.parse({ query: "x", minEnforcement: 0 }),
    ).toThrow();
    expect(() =>
      agentMemoryRecall.input.parse({ query: "x", minEnforcement: 101 }),
    ).toThrow();
  });

  it("rejects a limit above the cap", () => {
    expect(() =>
      agentMemoryRecall.input.parse({ query: "x", limit: 100 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMemoryRecall.output.parse({
      memories: [
        {
          id: "mem_1",
          nodeRef: "Function:apps/api/src/x.ts#auth",
          memoryClass: "RULE",
          memoryKind: "gotcha",
          lesson: "Refresh the token before extending the session.",
          source: "fix",
          confidenceScore: 92,
          enforcementScore: 80,
          score: 0.92,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(parsed.memories[0]?.memoryClass).toBe("RULE");
    expect(parsed.memories[0]?.enforcementScore).toBe(80);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("recall_memory")).toBe(agentMemoryRecall);
  });
});
