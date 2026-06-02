import { describe, expect, it } from "vitest";
import { agentMemoryWrite } from "./agent.memory.write";
import { getCapability } from "../registry";

describe("agent.memory.write capability", () => {
  it("parses a valid input", () => {
    const parsed = agentMemoryWrite.input.parse({
      nodeRef: "Function:apps/api/src/x.ts#auth",
      weight: "high",
      kind: "constraint",
      lesson: "Always batch the JWT-verify calls in the middleware.",
      source: "feature",
    });
    expect(parsed.weight).toBe("high");
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        weight: "high",
        kind: "note",
        lesson: "x",
        source: "feature",
      }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        weight: "high",
        kind: "constraint",
        lesson: "x",
        source: "review",
      }),
    ).toThrow();
  });

  it("rejects an empty lesson", () => {
    expect(() =>
      agentMemoryWrite.input.parse({
        nodeRef: "x",
        weight: "high",
        kind: "constraint",
        lesson: "",
        source: "feature",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMemoryWrite.output.parse({
      memoryId: "mem_1",
      nodeRef: "Function:x",
    });
    expect(parsed.memoryId).toBe("mem_1");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.memory.write")).toBe(agentMemoryWrite);
  });
});
