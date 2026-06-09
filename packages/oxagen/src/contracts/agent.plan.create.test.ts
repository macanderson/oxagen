import { describe, expect, it } from "vitest";
import { agentPlanCreate } from "./agent.plan.create";
import { getCapability } from "../registry";

const VALID_INPUT = {
  goals: ["Deploy service", "Run tests"],
  tasks: [
    { id: "t1", title: "Build image", dependsOn: [] },
    { id: "t2", title: "Run tests", dependsOn: ["t1"] },
  ],
};

describe("agent.plan.create capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = agentPlanCreate.input.parse(VALID_INPUT);
    expect(parsed.goals).toHaveLength(2);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.approvalRequired).toBe(true);
    expect(parsed.constraints).toEqual([]);
  });

  it("accepts constraints and messageId", () => {
    const parsed = agentPlanCreate.input.parse({
      ...VALID_INPUT,
      constraints: ["No side effects"],
      messageId: "msg_xyz",
      approvalRequired: false,
    });
    expect(parsed.constraints).toEqual(["No side effects"]);
    expect(parsed.messageId).toBe("msg_xyz");
    expect(parsed.approvalRequired).toBe(false);
  });

  it("rejects empty goals array", () => {
    expect(() =>
      agentPlanCreate.input.parse({ ...VALID_INPUT, goals: [] }),
    ).toThrow();
  });

  it("rejects more than 100 tasks", () => {
    const tooManyTasks = Array.from({ length: 101 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      dependsOn: [],
    }));
    expect(() =>
      agentPlanCreate.input.parse({ ...VALID_INPUT, tasks: tooManyTasks }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentPlanCreate.output.parse({
      planId: "pln_abc123",
      status: "awaiting_approval",
      goals: ["Deploy"],
      tasks: [{ id: "t1", title: "Step", dependsOn: [] }],
      approvalRequired: true,
      createdAt: new Date().toISOString(),
    });
    expect(parsed.planId).toBe("pln_abc123");
    expect(parsed.status).toBe("awaiting_approval");
  });

  it("rejects an unknown output status", () => {
    expect(() =>
      agentPlanCreate.output.parse({
        planId: "p",
        status: "running",
        goals: [],
        tasks: [],
        approvalRequired: true,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.plan.create")).toBe(agentPlanCreate);
  });
});
