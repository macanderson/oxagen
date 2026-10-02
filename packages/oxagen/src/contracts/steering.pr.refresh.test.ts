import { describe, expect, it } from "vitest";
import { steeringPrRefresh } from "./steering.pr.refresh";

describe("refresh_steering_pr contract", () => {
  it("is an unmetered write a workspace member makes without approval, off MCP", () => {
    expect(steeringPrRefresh.name).toBe("refresh_steering_pr");
    expect(steeringPrRefresh.mutates).toBe(true);
    expect(steeringPrRefresh.noBillingGate).toBe(true);
    expect(steeringPrRefresh.agent?.requiresApproval).toBe(false);
    expect(steeringPrRefresh.surfaces).toEqual(["api", "agent"]);
    expect(steeringPrRefresh.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  it("takes only the proposal id", () => {
    expect(
      steeringPrRefresh.input.safeParse({ proposalId: "prp_1" }).success,
    ).toBe(true);
    expect(
      steeringPrRefresh.input.safeParse({ proposalId: "ctr_1" }).success,
    ).toBe(false);
  });

  it("answers the host's state, or none before a pull request opens", () => {
    expect(
      steeringPrRefresh.output.safeParse({
        proposalId: "prp_1",
        status: "rejected",
        host: { state: "closed", headSha: "abc", baseRef: "main" },
        changed: true,
        syncRequested: false,
      }).success,
    ).toBe(true);
    expect(
      steeringPrRefresh.output.safeParse({
        proposalId: "prp_1",
        status: "proposed",
        host: null,
        changed: false,
        syncRequested: false,
      }).success,
    ).toBe(true);
  });
});
