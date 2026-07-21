import { describe, expect, it } from "vitest";
import { agentRoleGet } from "./agent.role.get";
import { getCapability } from "../registry";

describe("agent.role.get capability", () => {
  it("registers under its ADR-025 name", () => {
    expect(agentRoleGet.name).toBe("get_agent_role");
    expect(getCapability("get_agent_role")).toBe(agentRoleGet);
  });

  it("requires agentId and roleName", () => {
    expect(() => agentRoleGet.input.parse({ agentId: "agt_1" })).toThrow();
    const parsed = agentRoleGet.input.parse({
      agentId: "agt_1",
      roleName: "Agent Observer",
    });
    expect(parsed.roleName).toBe("Agent Observer");
  });

  it("validates an unassigned result with a grant list", () => {
    const out = agentRoleGet.output.parse({
      agentId: "agt_1",
      roleId: "rol_1",
      roleName: "Agent Observer",
      assigned: false,
      assignment: null,
      grants: [{ capability: "recall_memory", effect: "allow" }],
    });
    expect(out.assigned).toBe(false);
    expect(out.grants).toHaveLength(1);
  });
});
