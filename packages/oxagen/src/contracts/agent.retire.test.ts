import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentRetire } from "./agent.retire";

describe("retire_agent contract", () => {
  it("is a governance write on the identity: mutates, unmetered, Owner/Admin, approval-worthy", () => {
    expect(getCapability("retire_agent")).toBe(agentRetire);
    expect(agentRetire.mutates).toBe(true);
    expect(agentRetire.noBillingGate).toBe(true);
    expect(agentRetire.surfaces).toEqual(["api"]);
    expect(agentRetire.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(agentRetire.agent?.requiresApproval).toBe(true);
  });

  it("takes an id or slug and an optional reason", () => {
    expect(agentRetire.input.parse({ agentId: "agt_x" })).toEqual({
      agentId: "agt_x",
    });
    expect(agentRetire.input.safeParse({}).success).toBe(false);
  });

  it("answers retired with what this call revoked", () => {
    const out = agentRetire.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      status: "retired",
      revokedCredentials: 1,
      revokedHosts: 2,
      revokedMandates: 3,
      retiredAt: "2026-09-14T10:00:00.000Z",
    });
    expect(out.status).toBe("retired");
    expect(
      agentRetire.output.safeParse({ ...out, revokedHosts: -1 }).success,
    ).toBe(false);
    expect(
      agentRetire.output.safeParse({ ...out, revokedMandates: -1 }).success,
    ).toBe(false);
  });
});
