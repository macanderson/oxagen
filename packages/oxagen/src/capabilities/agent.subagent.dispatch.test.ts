import { describe, expect, it } from "vitest";
import { agentSubagentDispatch } from "./agent.subagent.dispatch.js";
import { getCapability } from "../registry.js";

describe("agent.subagent.dispatch capability", () => {
  it("parses a valid input", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_1",
      fanout: [
        { capability: "agent.memory.recall", input: { query: "x" }, label: "a" },
      ],
    });
    expect(parsed.fanout).toHaveLength(1);
  });

  it("rejects an empty fanout", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_1",
        fanout: [],
      }),
    ).toThrow();
  });

  it("rejects a fanout larger than 16", () => {
    const fanout = Array.from({ length: 17 }, () => ({
      capability: "agent.memory.recall",
      input: {},
    }));
    expect(() =>
      agentSubagentDispatch.input.parse({ parentMessageId: "msg", fanout }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentSubagentDispatch.output.parse({
      fanoutId: "fan_1",
      childMessageIds: ["msg_a", "msg_b"],
    });
    expect(parsed.childMessageIds).toHaveLength(2);
  });

  it("rejects a missing fanoutId", () => {
    expect(() =>
      agentSubagentDispatch.output.parse({ childMessageIds: [] }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.subagent.dispatch")).toBe(agentSubagentDispatch);
  });
});
