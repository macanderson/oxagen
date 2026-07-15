import { describe, expect, it } from "vitest";
import { agentTriggerList } from "./agent.trigger.list";
import { getCapability } from "../registry";

describe("agent.trigger.list capability", () => {
  it("parses a minimal input", () => {
    const parsed = agentTriggerList.input.parse({ agentId: "agt_1" });
    expect(parsed.agentId).toBe("agt_1");
  });

  it("parses a valid output with nullable fields", () => {
    const out = agentTriggerList.output.parse({
      triggers: [
        {
          triggerId: "atr_1",
          publicId: "atr_1",
          triggerType: "event",
          eventSource: "github_repo",
          eventType: "push",
          connectionId: null,
          filter: { branches: ["main"] },
          schedule: null,
          enabled: true,
        },
      ],
    });
    expect(out.triggers[0]!.eventSource).toBe("github_repo");
    expect(out.triggers[0]!.connectionId).toBeNull();
  });

  it("is exempt from the billing admission gate (read-only introspection)", () => {
    expect(agentTriggerList.noBillingGate).toBe(true);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_triggers")).toBe(agentTriggerList);
  });
});
