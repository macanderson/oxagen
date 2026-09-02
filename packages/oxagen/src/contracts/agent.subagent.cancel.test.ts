import { describe, expect, it } from "vitest";
import { agentSubagentCancel } from "./agent.subagent.cancel";
import { getCapability } from "../registry";

describe("agent.subagent.cancel capability", () => {
  it("parses a valid input", () => {
    const parsed = agentSubagentCancel.input.parse({ fanoutId: "fan_1" });
    expect(parsed.fanoutId).toBe("fan_1");
  });

  it("rejects input missing fanoutId", () => {
    expect(() => agentSubagentCancel.input.parse({})).toThrow();
  });

  it("rejects a non-string fanoutId", () => {
    expect(() => agentSubagentCancel.input.parse({ fanoutId: 42 })).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentSubagentCancel.output.parse({
      fanoutId: "fan_1",
      status: "timed_out",
      cancelledChildren: 3,
    });
    expect(parsed.cancelledChildren).toBe(3);
    expect(parsed.status).toBe("timed_out");
  });

  it("rejects a non-integer cancelledChildren", () => {
    expect(() =>
      agentSubagentCancel.output.parse({
        fanoutId: "fan_1",
        status: "timed_out",
        cancelledChildren: 1.5,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("cancel_subagent")).toBe(agentSubagentCancel);
  });
});
