import { describe, expect, it } from "vitest";
import { steeringProposalDismiss } from "./steering.proposal.dismiss";

describe("dismiss_proposal contract", () => {
  it("is an Owner/Admin write with an optional reason", () => {
    expect(steeringProposalDismiss.name).toBe("dismiss_proposal");
    expect(steeringProposalDismiss.mutates).toBe(true);
    expect(steeringProposalDismiss.noBillingGate).toBe(true);
    expect(steeringProposalDismiss.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    // Dismissed from the operator console; the MCP tool is a lane of its own.
    expect(steeringProposalDismiss.surfaces).toEqual(["api", "agent"]);
    expect(steeringProposalDismiss.layers).not.toContain("mcp");
    // A dismissal closes the steering PR and deletes its branch, so Stella
    // asks a person first.
    expect(steeringProposalDismiss.agent?.requiresApproval).toBe(true);
    // The steering PR page's Close takes an optional reason (#5077).
    expect(
      steeringProposalDismiss.input.safeParse({ proposalId: "prp_1" }).success,
    ).toBe(true);
    expect(
      steeringProposalDismiss.input.safeParse({
        proposalId: "prp_1",
        reason: "   ",
      }).success,
    ).toBe(false);
    expect(
      steeringProposalDismiss.input.safeParse({
        proposalId: "ctr_1",
        reason: "x",
      }).success,
    ).toBe(false);
  });

  it("answers the rejected state and nothing else", () => {
    expect(
      steeringProposalDismiss.output.safeParse({
        proposalId: "prp_1",
        status: "proposed",
      }).success,
    ).toBe(false);
  });
});
