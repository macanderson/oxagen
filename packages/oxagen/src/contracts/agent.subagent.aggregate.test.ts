import { describe, expect, it } from "vitest";
import { agentSubagentAggregate } from "./agent.subagent.aggregate.js";
import { getCapability } from "../registry.js";

describe("agent.subagent.aggregate capability", () => {
  it("parses a valid input", () => {
    const parsed = agentSubagentAggregate.input.parse({ fanoutId: "fan_1" });
    expect(parsed.waitForCompletion).toBe(true);
    expect(parsed.timeoutMs).toBe(120_000);
  });

  it("rejects a non-positive timeout", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({ fanoutId: "fan_1", timeoutMs: 0 }),
    ).toThrow();
  });

  it("rejects a timeout above the cap", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({
        fanoutId: "fan_1",
        timeoutMs: 1_000_000,
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fan_1",
      status: "completed",
      results: [
        {
          childMessageId: "msg_a",
          capability: "agent.memory.recall",
          status: "completed",
          output: { memories: [] },
          error: null,
        },
      ],
    });
    expect(parsed.results).toHaveLength(1);
  });

  it("rejects an unknown result status", () => {
    expect(() =>
      agentSubagentAggregate.output.parse({
        fanoutId: "fan_1",
        status: "completed",
        results: [
          {
            childMessageId: "msg_a",
            capability: "x",
            status: "weird",
            output: null,
            error: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.subagent.aggregate")).toBe(agentSubagentAggregate);
  });
});
