import { describe, expect, it } from "vitest";
import { agentRoleList } from "./agent.role.list";
import { getCapability } from "../registry";

describe("agent.role.list capability", () => {
  it("registers under its ADR-025 name", () => {
    expect(agentRoleList.name).toBe("list_agent_roles");
    expect(getCapability("list_agent_roles")).toBe(agentRoleList);
  });

  it("is a billing-exempt read", () => {
    expect(agentRoleList.noBillingGate).toBe(true);
    expect(agentRoleList.agent?.riskLevel).toBe("low");
  });

  it("parses input and validates the assignment row shape", () => {
    expect(() => agentRoleList.input.parse({})).toThrow();
    const out = agentRoleList.output.parse({
      agentId: "agt_1",
      roles: [
        {
          assignmentId: "pra_1",
          roleId: "rol_1",
          roleName: "Agent Contributor",
          scopeKind: "org",
          isSystemDefault: true,
          assignedAt: "2026-07-20T00:00:00.000Z",
          assignedBy: null,
          expiresAt: null,
          workspaceId: null,
        },
      ],
      total: 1,
    });
    expect(out.roles[0]?.roleName).toBe("Agent Contributor");
  });
});
