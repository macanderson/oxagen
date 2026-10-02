import { describe, expect, it } from "vitest";
import { steeringPrMerge } from "./steering.pr.merge";
import { steeringPrRevert } from "./steering.pr.revert";

describe("revert_steering_pr contract", () => {
  it("is a merge-class write: merge_steering_pr's roles, approval and risk, unmetered", () => {
    expect(steeringPrRevert.name).toBe("revert_steering_pr");
    expect(steeringPrRevert.mutates).toBe(true);
    expect(steeringPrRevert.noBillingGate).toBe(true);
    expect(steeringPrRevert.sensitivity).toBe("high");
    expect(steeringPrRevert.defaultEffect).toBe("deny");
    expect(steeringPrRevert.defaultRoles).toEqual(steeringPrMerge.defaultRoles);
    expect(steeringPrRevert.agent).toEqual(steeringPrMerge.agent);
  });

  it("is on every surface, with a layer for each", () => {
    expect(steeringPrRevert.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(steeringPrRevert.layers).toEqual(
      expect.arrayContaining(["schema", "api", "mcp", "cli", "unit", "docs", "app"]),
    );
  });

  it("takes a proposal id and nothing else", () => {
    expect(steeringPrRevert.input.parse({ proposalId: "prp_01k5ru4a" })).toEqual(
      { proposalId: "prp_01k5ru4a" },
    );
    expect(steeringPrRevert.input.safeParse({ proposalId: "ctr_1" }).success).toBe(
      false,
    );
    expect(
      steeringPrRevert.input.safeParse({ proposalId: "prp_1", number: 7 }).success,
    ).toBe(false);
  });

  it("answers the merged PR, the revert PR and the check on its head", () => {
    const out = steeringPrRevert.output.parse({
      proposalId: "prp_1",
      reverted: { number: 519, mergedCommit: "7d2e91a0" },
      pullRequest: {
        number: 520,
        url: "https://github.com/a-intel/platform/pull/520",
        branch: "steering/revert-519",
        headSha: "head9",
      },
      check: "success",
      revertProposalId: "prp_2",
    });
    expect(out.pullRequest.branch).toBe("steering/revert-519");
    // The revert's own proposal, which merge_steering_pr lands (#5122). A
    // legacy repository's revert has none.
    expect(out.revertProposalId).toBe("prp_2");
    expect(
      steeringPrRevert.output.safeParse({ ...out, revertProposalId: null }).success,
    ).toBe(true);
    // A legacy repository has no required check, so none is reported.
    expect(
      steeringPrRevert.output.safeParse({ ...out, check: null }).success,
    ).toBe(true);
    expect(
      steeringPrRevert.output.safeParse({ ...out, check: "skipped" }).success,
    ).toBe(false);
    expect(
      steeringPrRevert.output.safeParse({
        ...out,
        reverted: { number: 0, mergedCommit: "7d2e91a0" },
      }).success,
    ).toBe(false);
  });
});
