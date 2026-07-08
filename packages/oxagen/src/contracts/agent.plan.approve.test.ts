import { describe, expect, it } from "vitest";
import { agentPlanApprove } from "./agent.plan.approve";
import { getCapability } from "../registry";

describe("agent.plan.approve capability", () => {
  it("parses a valid approve input", () => {
    const parsed = agentPlanApprove.input.parse({
      planId: "plan_1",
      decision: "approve",
    });
    expect(parsed.decision).toBe("approve");
  });

  it("parses a valid amend input with amendedSteps", () => {
    const parsed = agentPlanApprove.input.parse({
      planId: "plan_1",
      decision: "amend",
      amendedSteps: [
        {
          id: "s1",
          summary: "Reworked step",
          intent: "Update tokens differently",
          capability: null,
          inputPreview: null,
          dependsOn: [],
        },
      ],
    });
    expect(parsed.amendedSteps).toHaveLength(1);
  });

  it("rejects an unknown decision", () => {
    expect(() =>
      agentPlanApprove.input.parse({ planId: "plan_1", decision: "maybe" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentPlanApprove.output.parse({
      planId: "plan_1",
      status: "approved",
    });
    expect(parsed.status).toBe("approved");
  });

  it("rejects an unknown output status", () => {
    expect(() =>
      agentPlanApprove.output.parse({ planId: "p", status: "pending" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("approve_plan")).toBe(agentPlanApprove);
  });
});
