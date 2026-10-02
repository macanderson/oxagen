import { describe, expect, it } from "vitest";
import { contextPrMerge } from "./context.pr.merge";
import { contextPrRevert } from "./context.pr.revert";

describe("revert_steering_pr contract", () => {
  it("is a merge-class write: merge_context_pr's roles, approval and risk, unmetered", () => {
    expect(contextPrRevert.name).toBe("revert_steering_pr");
    expect(contextPrRevert.mutates).toBe(true);
    expect(contextPrRevert.noBillingGate).toBe(true);
    expect(contextPrRevert.sensitivity).toBe("high");
    expect(contextPrRevert.defaultEffect).toBe("deny");
    expect(contextPrRevert.defaultRoles).toEqual(contextPrMerge.defaultRoles);
    expect(contextPrRevert.agent).toEqual(contextPrMerge.agent);
  });

  it("is on every surface, with a layer for each", () => {
    expect(contextPrRevert.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(contextPrRevert.layers).toEqual(
      expect.arrayContaining(["schema", "api", "mcp", "cli", "unit", "docs", "app"]),
    );
  });

  it("takes a proposal id and nothing else", () => {
    expect(contextPrRevert.input.parse({ proposalId: "prp_01k5ru4a" })).toEqual(
      { proposalId: "prp_01k5ru4a" },
    );
    expect(contextPrRevert.input.safeParse({ proposalId: "ctr_1" }).success).toBe(
      false,
    );
    expect(
      contextPrRevert.input.safeParse({ proposalId: "prp_1", number: 7 }).success,
    ).toBe(false);
  });

  it("answers the merged PR, the revert PR and the check on its head", () => {
    const out = contextPrRevert.output.parse({
      proposalId: "prp_1",
      reverted: { number: 519, mergedCommit: "7d2e91a0" },
      pullRequest: {
        number: 520,
        url: "https://github.com/a-intel/platform/pull/520",
        branch: "steering/revert-519",
        headSha: "head9",
      },
      check: "success",
    });
    expect(out.pullRequest.branch).toBe("steering/revert-519");
    // A legacy repository has no required check, so none is reported.
    expect(
      contextPrRevert.output.safeParse({ ...out, check: null }).success,
    ).toBe(true);
    expect(
      contextPrRevert.output.safeParse({ ...out, check: "skipped" }).success,
    ).toBe(false);
    expect(
      contextPrRevert.output.safeParse({
        ...out,
        reverted: { number: 0, mergedCommit: "7d2e91a0" },
      }).success,
    ).toBe(false);
  });
});
