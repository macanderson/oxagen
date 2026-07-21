import { describe, expect, it } from "vitest";
import { agentRoleRevoke } from "./agent.role.revoke";
import { getCapability } from "../registry";

describe("agent.role.revoke capability", () => {
  it("registers under its ADR-025 name", () => {
    expect(agentRoleRevoke.name).toBe("revoke_agent_role");
    expect(getCapability("revoke_agent_role")).toBe(agentRoleRevoke);
  });

  it("requires agentId and roleName", () => {
    expect(() => agentRoleRevoke.input.parse({})).toThrow();
    const parsed = agentRoleRevoke.input.parse({
      agentId: "agt_1",
      roleName: "Agent Operator",
    });
    expect(parsed.agentId).toBe("agt_1");
  });

  it("declares deny-by-default with high sensitivity", () => {
    expect(agentRoleRevoke.defaultEffect).toBe("deny");
    expect(agentRoleRevoke.sensitivity).toBe("high");
  });

  it("output reports idempotent revocation", () => {
    const out = agentRoleRevoke.output.parse({
      revoked: false,
      agentId: "agt_1",
      roleName: "Agent Operator",
    });
    expect(out.revoked).toBe(false);
  });
});
