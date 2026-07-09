import { describe, expect, it } from "vitest";
import { agentMemoryWrite } from "./agent.memory.write";
import { getCapability } from "../registry";

describe("agent.memory.write capability", () => {
  it("parses a valid input and defaults memoryClass to OBSERVATION", () => {
    const parsed = agentMemoryWrite.input.parse({
      nodeRef: "Function:apps/api/src/x.ts#auth",
      memoryKind: "constraint",
      lesson: "Always batch the JWT-verify calls in the middleware.",
      source: "feature",
    });
    expect(parsed.memoryClass).toBe("OBSERVATION");
    expect(parsed.memoryKind).toBe("constraint");
  });

  it("accepts a pinned RULE with an enforcementScore", () => {
    const parsed = agentMemoryWrite.input.parse({
      nodeRef: "x",
      memoryClass: "RULE",
      memoryKind: "constraint",
      enforcementScore: 80,
      lesson: "x",
      source: "feature",
    });
    expect(parsed.memoryClass).toBe("RULE");
    expect(parsed.enforcementScore).toBe(80);
  });

  it("rejects an unknown source", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        memoryKind: "constraint",
        lesson: "x",
        source: "review",
      }),
    ).toThrow();
  });

  it("rejects an empty lesson", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        memoryKind: "constraint",
        lesson: "",
        source: "feature",
      }),
    ).toThrow();
  });

  it("rejects an empty memoryKind", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        memoryKind: "",
        lesson: "x",
        source: "feature",
      }),
    ).toThrow();
  });

  it("rejects an enforcementScore out of the 1-100 range", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        memoryKind: "constraint",
        enforcementScore: 0,
        lesson: "x",
        source: "feature",
      }),
    ).toThrow();
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        memoryKind: "constraint",
        enforcementScore: 101,
        lesson: "x",
        source: "feature",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMemoryWrite.output.parse({
      memoryId: "mem_1",
      nodeRef: "Function:x",
      edgesCreated: 3,
    });
    expect(parsed.memoryId).toBe("mem_1");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("write_memory")).toBe(agentMemoryWrite);
  });
});
