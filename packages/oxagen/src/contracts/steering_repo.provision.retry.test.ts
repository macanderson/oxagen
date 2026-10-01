import { describe, expect, it } from "vitest";
import { steeringRepoProvisionRetry } from "./steering_repo.provision.retry";

describe("retry_steering_repo_provision contract", () => {
  it("is a high-sensitivity api-only write, outside metering", () => {
    expect(steeringRepoProvisionRetry.name).toBe("retry_steering_repo_provision");
    expect(steeringRepoProvisionRetry.scoped).toBe(true);
    expect(steeringRepoProvisionRetry.mutates).toBe(true);
    expect(steeringRepoProvisionRetry.noBillingGate).toBe(true);
    expect(steeringRepoProvisionRetry.sensitivity).toBe("high");
    expect(steeringRepoProvisionRetry.surfaces).toEqual(["api", "agent"]);
  });

  it("is for org Owners and Admins only", () => {
    expect(steeringRepoProvisionRetry.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("is off the mcp surface, and on the agent surface behind a person's approval", () => {
    expect(steeringRepoProvisionRetry.surfaces).not.toContain("mcp");
    expect(steeringRepoProvisionRetry.surfaces).toContain("agent");
    expect(steeringRepoProvisionRetry.agent?.requiresApproval).toBe(true);
  });

  it("takes nothing, or the connection a blocked setup chooses", () => {
    expect(steeringRepoProvisionRetry.input.parse({})).toEqual({});
    const pick = { connection: { provider: "github", id: 11 } };
    expect(steeringRepoProvisionRetry.input.parse(pick)).toEqual(pick);
    expect(
      steeringRepoProvisionRetry.input.safeParse({
        connection: { provider: "bitbucket", id: 11 },
      }).success,
    ).toBe(false);
    expect(
      steeringRepoProvisionRetry.input.safeParse({
        connection: { provider: "github", id: 11, name: "acme" },
      }).success,
    ).toBe(false);
    expect(steeringRepoProvisionRetry.input.safeParse({ force: true }).success).toBe(false);
  });

  it("takes resetConnection to clear the stored connection first", () => {
    expect(
      steeringRepoProvisionRetry.input.parse({ resetConnection: true }),
    ).toEqual({ resetConnection: true });
    expect(
      steeringRepoProvisionRetry.input.safeParse({ resetConnection: "yes" }).success,
    ).toBe(false);
  });

  it("answers one steering repo status", () => {
    for (const status of ["provisioning", "ready", "failed", "blocked"] as const)
      expect(steeringRepoProvisionRetry.output.parse({ status })).toEqual({ status });
    expect(steeringRepoProvisionRetry.output.safeParse({ status: "done" }).success).toBe(false);
    expect(steeringRepoProvisionRetry.output.safeParse({}).success).toBe(false);
  });
});
