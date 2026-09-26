import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentMove } from "./agent.move";

describe("move_agent contract", () => {
  it("is an identity write on api and mcp for org Owner/Admin", () => {
    expect(getCapability("move_agent")).toBe(agentMove);
    expect(agentMove.mutates).toBe(true);
    expect(agentMove.noBillingGate).toBe(true);
    expect(agentMove.surfaces).toEqual(["api", "mcp"]);
    expect(agentMove.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(agentMove.agent?.requiresApproval).toBe(true);
  });

  it("takes an agent by id or slug and a runtime by public id only", () => {
    const runtimeId = "rtm_0123456789abcdefghjkmn";
    expect(
      agentMove.input.safeParse({ agentId: "release-bot", runtimeId }).success,
    ).toBe(true);
    expect(
      agentMove.input.safeParse({ agentId: "release-bot", runtimeId: "cloud" })
        .success,
    ).toBe(false);
  });

  it("answers with the new runtime, the version it wrote, and the hosts it revoked", () => {
    const out = {
      agentId: "agt_0123456789abcdefghjkmn",
      runtime: {
        id: "rtm_0123456789abcdefghjkmn",
        name: "Cloud VM",
        slug: "cloud-vm",
      },
      version: 2,
      revokedHosts: 1,
    };
    expect(agentMove.output.parse(out)).toEqual(out);
    expect(agentMove.output.safeParse({ ...out, version: 0 }).success).toBe(
      false,
    );
  });
});
