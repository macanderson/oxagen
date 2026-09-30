import { describe, expect, it } from "vitest";
import { steeringRepoProvisionRetry } from "./steering_repo.provision.retry";

describe("retry_steering_repo_provision contract", () => {
  it("is a high-sensitivity api-only write, outside metering", () => {
    expect(steeringRepoProvisionRetry.name).toBe("retry_steering_repo_provision");
    expect(steeringRepoProvisionRetry.scoped).toBe(true);
    expect(steeringRepoProvisionRetry.mutates).toBe(true);
    expect(steeringRepoProvisionRetry.noBillingGate).toBe(true);
    expect(steeringRepoProvisionRetry.sensitivity).toBe("high");
    expect(steeringRepoProvisionRetry.surfaces).toEqual(["api"]);
  });

  it("is for org Owners and Admins only", () => {
    expect(steeringRepoProvisionRetry.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("is an admin button, off the agent and mcp surfaces", () => {
    expect(steeringRepoProvisionRetry.surfaces).not.toContain("agent");
    expect(steeringRepoProvisionRetry.surfaces).not.toContain("mcp");
    expect("agent" in steeringRepoProvisionRetry).toBe(false);
  });

  it("takes nothing", () => {
    expect(steeringRepoProvisionRetry.input.parse({})).toEqual({});
    expect(steeringRepoProvisionRetry.input.safeParse({ force: true }).success).toBe(false);
  });

  it("answers one steering repo status", () => {
    for (const status of ["provisioning", "ready", "failed", "blocked"] as const)
      expect(steeringRepoProvisionRetry.output.parse({ status })).toEqual({ status });
    expect(steeringRepoProvisionRetry.output.safeParse({ status: "done" }).success).toBe(false);
    expect(steeringRepoProvisionRetry.output.safeParse({}).success).toBe(false);
  });
});
