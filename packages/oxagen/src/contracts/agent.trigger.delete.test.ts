import { describe, expect, it } from "vitest";
import { agentTriggerDelete } from "./agent.trigger.delete";
import { getCapability } from "../registry";

describe("agent.trigger.delete capability", () => {
  it("parses a minimal input", () => {
    const parsed = agentTriggerDelete.input.parse({ triggerId: "atr_1" });
    expect(parsed.triggerId).toBe("atr_1");
  });

  it("rejects missing triggerId", () => {
    expect(() => agentTriggerDelete.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentTriggerDelete.output.parse({
      triggerId: "atr_1",
      deleted: true,
    });
    expect(out.deleted).toBe(true);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.trigger.delete")).toBe(agentTriggerDelete);
  });
});
