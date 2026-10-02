import { describe, expect, it } from "vitest";
import { contextProposalDismiss } from "./context.proposal.dismiss";

describe("dismiss_proposal contract", () => {
  it("is an Owner/Admin write with an optional reason", () => {
    expect(contextProposalDismiss.name).toBe("dismiss_proposal");
    expect(contextProposalDismiss.mutates).toBe(true);
    expect(contextProposalDismiss.noBillingGate).toBe(true);
    expect(contextProposalDismiss.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    // Dismissed from the operator console; the MCP tool is a lane of its own.
    expect(contextProposalDismiss.surfaces).toEqual(["api", "agent"]);
    expect(contextProposalDismiss.layers).not.toContain("mcp");
    // A dismissal closes the Context PR and deletes its branch, so Stella
    // asks a person first.
    expect(contextProposalDismiss.agent?.requiresApproval).toBe(true);
    // The Context PR page's Close takes an optional reason (#5077).
    expect(
      contextProposalDismiss.input.safeParse({ proposalId: "prp_1" }).success,
    ).toBe(true);
    expect(
      contextProposalDismiss.input.safeParse({
        proposalId: "prp_1",
        reason: "   ",
      }).success,
    ).toBe(false);
    expect(
      contextProposalDismiss.input.safeParse({
        proposalId: "ctr_1",
        reason: "x",
      }).success,
    ).toBe(false);
  });

  it("answers the rejected state and nothing else", () => {
    expect(
      contextProposalDismiss.output.safeParse({
        proposalId: "prp_1",
        status: "proposed",
      }).success,
    ).toBe(false);
  });
});
