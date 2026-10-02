import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { steeringPrApprove } from "./steering.pr.approve";

describe("approve_steering_pr contract", () => {
  it("registers under its own name", () => {
    expect(getCapability("approve_steering_pr")).toBe(steeringPrApprove);
  });

  it("is a governed write for members, reached only with a person's session", () => {
    expect(steeringPrApprove.mutates).toBe(true);
    expect(steeringPrApprove.noBillingGate).toBe(true);
    expect(steeringPrApprove.sensitivity).toBe("high");
    expect(steeringPrApprove.defaultEffect).toBe("deny");
    expect(steeringPrApprove.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    // A review is a person's decision: no agent, MCP, or CLI surface (ADR-267).
    expect(steeringPrApprove.surfaces).toEqual(["api"]);
  });

  it("takes a proposal id and nothing else", () => {
    expect(
      steeringPrApprove.input.safeParse({ proposalId: "prp_abc123" }).success,
    ).toBe(true);
    expect(
      steeringPrApprove.input.safeParse({ proposalId: "not-an-id" }).success,
    ).toBe(false);
    expect(
      steeringPrApprove.input.safeParse({
        proposalId: "prp_abc123",
        headSha: "abc1234",
      }).success,
    ).toBe(false);
  });

  it("answers the approved head and a count of at least one", () => {
    expect(
      steeringPrApprove.output.safeParse({
        proposalId: "prp_abc123",
        headSha: "abc1234",
        approvals: 1,
      }).success,
    ).toBe(true);
    expect(
      steeringPrApprove.output.safeParse({
        proposalId: "prp_abc123",
        headSha: "abc1234",
        approvals: 0,
      }).success,
    ).toBe(false);
  });
});
