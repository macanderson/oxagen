import { describe, expect, it } from "vitest";
import { agentTriggerCreate } from "./agent.trigger.create";
import { getCapability } from "../registry";

describe("agent.trigger.create capability", () => {
  it("parses a manual trigger", () => {
    const parsed = agentTriggerCreate.input.parse({
      agentId: "agt_1",
      trigger: { type: "manual", enabled: true },
    });
    expect(parsed.trigger.type).toBe("manual");
    expect(parsed.trigger.enabled).toBe(true);
  });

  it("parses a schedule trigger with a cron expression", () => {
    const parsed = agentTriggerCreate.input.parse({
      agentId: "agt_1",
      trigger: { type: "schedule", schedule: "0 9 * * *", enabled: true },
    });
    expect(parsed.trigger.schedule).toBe("0 9 * * *");
  });

  it("rejects a schedule trigger without a cron expression (superRefine)", () => {
    expect(() =>
      agentTriggerCreate.input.parse({
        agentId: "agt_1",
        trigger: { type: "schedule", enabled: true },
      }),
    ).toThrow();
  });

  it("rejects an event trigger missing eventSource/eventType", () => {
    expect(() =>
      agentTriggerCreate.input.parse({
        agentId: "agt_1",
        trigger: { type: "event", enabled: true },
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentTriggerCreate.output.parse({
      triggerId: "atr_1",
      publicId: "atr_1",
      triggerType: "manual",
      enabled: true,
    });
    expect(out.triggerType).toBe("manual");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.trigger.create")).toBe(agentTriggerCreate);
  });
});
