import { describe, expect, it } from "vitest";
import { automationUpdate } from "./automation.update";
import { getCapability } from "../registry";

describe("automation.update capability", () => {
  it("parses a rename-only input", () => {
    const parsed = automationUpdate.input.parse({
      automation_id: "plt_1",
      name: "New name",
    });
    expect(parsed.name).toBe("New name");
    expect(parsed.description).toBeUndefined();
    expect(parsed.triggerConfig).toBeUndefined();
  });

  it("accepts null to clear the description", () => {
    const parsed = automationUpdate.input.parse({
      automation_id: "plt_1",
      description: null,
    });
    expect(parsed.description).toBeNull();
  });

  it("parses a schedule triggerConfig", () => {
    const parsed = automationUpdate.input.parse({
      automation_id: "plt_1",
      triggerConfig: {
        cronExpression: "0 9 * * 1",
        timezone: "America/New_York",
      },
    });
    expect(parsed.triggerConfig?.cronExpression).toBe("0 9 * * 1");
  });

  it("rejects a missing automation_id", () => {
    expect(() => automationUpdate.input.parse({ name: "x" })).toThrow();
  });

  it("rejects an invalid event triggerConfig eventType", () => {
    expect(() =>
      automationUpdate.input.parse({
        automation_id: "plt_1",
        triggerConfig: { eventType: "node.exploded" },
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_automation")).toBe(automationUpdate);
  });
});
