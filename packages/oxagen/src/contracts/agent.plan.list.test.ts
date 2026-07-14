import { describe, expect, it } from "vitest";
import { agentPlanList } from "./agent.plan.list";
import { getCapability } from "../registry";

describe("agent.plan.list capability", () => {
  it("is registered as list_plans in the agent domain", () => {
    expect(agentPlanList.name).toBe("list_plans");
    expect(agentPlanList.domain).toBe("agent");
    expect(getCapability("list_plans")).toBeDefined();
  });

  it("defaults limit to 20 and leaves status/cursor optional", () => {
    const parsed = agentPlanList.input.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.status).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it("rejects a limit above 100", () => {
    expect(() => agentPlanList.input.parse({ limit: 101 })).toThrow();
  });

  it("parses an output page with a nextCursor", () => {
    const out = agentPlanList.output.parse({
      plans: [
        {
          planId: "apl_1",
          status: "draft",
          goals: ["g"],
          approvalRequired: true,
          approvedAt: null,
          taskCount: 1,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      nextCursor: "2026-05-01T00:00:00.000Z",
    });
    expect(out.plans).toHaveLength(1);
    expect(out.nextCursor).not.toBeNull();
  });
});
