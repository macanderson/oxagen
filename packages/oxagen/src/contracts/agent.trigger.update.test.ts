import { describe, expect, it } from "vitest";
import { agentTriggerUpdate } from "./agent.trigger.update";
import { getCapability } from "../registry";

describe("agent.trigger.update capability", () => {
  it("parses an event trigger update", () => {
    const parsed = agentTriggerUpdate.input.parse({
      triggerId: "atr_1",
      trigger: {
        type: "event",
        eventSource: "github_repo",
        eventType: "push",
        enabled: true,
      },
    });
    expect(parsed.trigger.eventSource).toBe("github_repo");
  });

  it("rejects an event trigger missing eventType", () => {
    expect(() =>
      agentTriggerUpdate.input.parse({
        triggerId: "atr_1",
        trigger: { type: "event", eventSource: "github_repo", enabled: true },
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentTriggerUpdate.output.parse({
      triggerId: "atr_1",
      triggerType: "event",
      enabled: false,
    });
    expect(out.enabled).toBe(false);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.trigger.update")).toBe(agentTriggerUpdate);
  });
});
