import { describe, expect, it } from "vitest";
import { agentMemoryRecall } from "./agent.memory.recall.js";
import { getCapability } from "../registry.js";

describe("agent.memory.recall capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentMemoryRecall.input.parse({ query: "auth" });
    expect(parsed.minWeight).toBe("high");
    expect(parsed.limit).toBe(10);
  });

  it("rejects an empty query", () => {
    expect(() => agentMemoryRecall.input.parse({ query: "" })).toThrow();
  });

  it("rejects an unknown weight", () => {
    expect(() =>
      agentMemoryRecall.input.parse({ query: "x", minWeight: "medium" }),
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
          weight: "high",
          kind: "gotcha",
          lesson: "Refresh the token before extending the session.",
          source: "fix",
          score: 0.92,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(parsed.memories[0]?.weight).toBe("high");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.memory.recall")).toBe(agentMemoryRecall);
  });
});
