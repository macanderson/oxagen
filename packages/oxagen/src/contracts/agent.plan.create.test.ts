import { describe, expect, it } from "vitest";
import { agentPlanCreate } from "./agent.plan.create";
import { getCapability } from "../registry";

describe("agent.plan.create capability", () => {
  it("parses a valid input", () => {
    const parsed = agentPlanCreate.input.parse({
      parentMessageId: "msg_1",
      title: "Add dark mode",
      steps: [
        {
          id: "s1",
          summary: "Update tokens",
          intent: "Switch to OKLCH tokens",
          capability: null,
          inputPreview: null,
          dependsOn: [],
        },
      ],
    });
    expect(parsed.steps).toHaveLength(1);
  });

  it("rejects an empty steps array", () => {
    expect(() =>
      agentPlanCreate.input.parse({
        parentMessageId: "msg_1",
        title: "x",
        steps: [],
      }),
    ).toThrow();
  });

  it("rejects an empty step id", () => {
    expect(() =>
      agentPlanCreate.input.parse({
        parentMessageId: "msg_1",
        title: "x",
        steps: [
          {
            id: "",
            summary: "y",
            intent: "z",
            capability: null,
            inputPreview: null,
            dependsOn: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentPlanCreate.output.parse({
      planId: "plan_1",
      status: "pending_approval",
    });
    expect(parsed.status).toBe("pending_approval");
  });

  it("rejects a non-literal status", () => {
    expect(() =>
      agentPlanCreate.output.parse({ planId: "p", status: "approved" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.plan.create")).toBe(agentPlanCreate);
  });
});
