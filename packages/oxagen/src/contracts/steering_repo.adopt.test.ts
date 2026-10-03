import { describe, expect, it } from "vitest";
import { steeringRepoAdopt } from "./steering_repo.adopt";

describe("adopt_steering_merges contract", () => {
  it("is a high-sensitivity workspace write on api, mcp, and agent, outside metering", () => {
    expect(steeringRepoAdopt.name).toBe("adopt_steering_merges");
    expect(steeringRepoAdopt.scoped).toBe(true);
    expect(steeringRepoAdopt.mutates).toBe(true);
    expect(steeringRepoAdopt.noBillingGate).toBe(true);
    expect(steeringRepoAdopt.sensitivity).toBe("high");
    expect(steeringRepoAdopt.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(steeringRepoAdopt.agent).toMatchObject({ requiresApproval: true, riskLevel: "high" });
  });

  it("admits every role a governance mode can let merge, and the handler narrows it", () => {
    expect(steeringRepoAdopt.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("takes nothing", () => {
    expect(steeringRepoAdopt.input.parse({})).toEqual({});
    expect(steeringRepoAdopt.input.safeParse({ commits: [] }).success).toBe(false);
  });

  it("answers the health, the adopted merges, and the published version", () => {
    const out = {
      health: "healthy",
      adopted: [{ commit: "c3".repeat(20), pullRequest: 2 }],
      publishedVersion: 4,
    };
    expect(steeringRepoAdopt.output.parse(out)).toEqual(out);
    expect(steeringRepoAdopt.output.parse({ ...out, publishedVersion: null }).publishedVersion).toBeNull();
    expect(steeringRepoAdopt.output.safeParse({ ...out, adopted: [{ commit: "x", pullRequest: 0 }] }).success).toBe(false);
  });
});
