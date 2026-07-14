import { describe, expect, it } from "vitest";
import { agentPlanGet } from "./agent.plan.get";
import { getCapability } from "../registry";

describe("agent.plan.get capability", () => {
  it("is registered as get_plan in the agent domain", () => {
    expect(agentPlanGet.name).toBe("get_plan");
    expect(agentPlanGet.domain).toBe("agent");
    expect(getCapability("get_plan")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(agentPlanGet.input.parse({ planId: "apl_1" }).planId).toBe("apl_1");
  });

  it("rejects a missing planId", () => {
    expect(() => agentPlanGet.input.parse({})).toThrow();
  });

  it("parses a full plan-view output", () => {
    const out = agentPlanGet.output.parse({
      planId: "apl_1",
      status: "approved",
      goals: ["g"],
      constraints: [],
      tasks: [{ id: "t1" }],
      approvalRequired: true,
      approvedAt: null,
      approvedByUserId: null,
      taskCount: 1,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    expect(out.tasks).toHaveLength(1);
  });
});
