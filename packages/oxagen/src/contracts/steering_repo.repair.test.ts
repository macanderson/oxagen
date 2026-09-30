import { describe, expect, it } from "vitest";
import { REPO_HEALTH_STATES } from "../steering-repo/health";
import { steeringRepoRepair } from "./steering_repo.repair";

describe("repair_steering_repo contract", () => {
  it("is a high-sensitivity workspace write on api and mcp, outside metering", () => {
    expect(steeringRepoRepair.name).toBe("repair_steering_repo");
    expect(steeringRepoRepair.scoped).toBe(true);
    expect(steeringRepoRepair.mutates).toBe(true);
    expect(steeringRepoRepair.noBillingGate).toBe(true);
    expect(steeringRepoRepair.sensitivity).toBe("high");
    expect(steeringRepoRepair.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("is for org Owners and Admins only", () => {
    expect(steeringRepoRepair.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("is on the agent surface behind a person's approval", () => {
    expect(steeringRepoRepair.surfaces).toContain("agent");
    expect(steeringRepoRepair.agent).toMatchObject({
      requiresApproval: true,
      riskLevel: "high",
    });
  });

  it("takes nothing", () => {
    expect(steeringRepoRepair.input.parse({})).toEqual({});
    expect(steeringRepoRepair.input.safeParse({ force: true }).success).toBe(false);
  });

  it("answers one health state", () => {
    for (const health of REPO_HEALTH_STATES)
      expect(steeringRepoRepair.output.parse({ health })).toEqual({ health });
    expect(steeringRepoRepair.output.safeParse({ health: "fixed" }).success).toBe(false);
    expect(steeringRepoRepair.output.safeParse({}).success).toBe(false);
  });
});
