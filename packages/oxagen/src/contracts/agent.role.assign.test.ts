import { describe, expect, it } from "vitest";
import { agentRoleAssign } from "./agent.role.assign";
import { getCapability } from "../registry";

describe("agent.role.assign capability", () => {
  it("registers under its ADR-025 name", () => {
    expect(agentRoleAssign.name).toBe("assign_agent_role");
    expect(getCapability("assign_agent_role")).toBe(agentRoleAssign);
  });

  it("requires agentId and roleName", () => {
    expect(() => agentRoleAssign.input.parse({})).toThrow();
    expect(() =>
      agentRoleAssign.input.parse({ agentId: "", roleName: "" }),
    ).toThrow();
    const parsed = agentRoleAssign.input.parse({
      agentId: "agt_1",
      roleName: "Agent Contributor",
    });
    expect(parsed.roleName).toBe("Agent Contributor");
  });

  it("declares deny-by-default, high sensitivity, approval-gated mutation", () => {
    expect(agentRoleAssign.defaultEffect).toBe("deny");
    expect(agentRoleAssign.sensitivity).toBe("high");
    expect(agentRoleAssign.agent?.requiresApproval).toBe(true);
    expect(agentRoleAssign.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("validates the output shape", () => {
    const out = agentRoleAssign.output.parse({
      assigned: true,
      alreadyAssigned: false,
      agentId: "agt_1",
      roleId: "rol_1",
      roleName: "Agent Contributor",
    });
    expect(out.assigned).toBe(true);
  });
});
