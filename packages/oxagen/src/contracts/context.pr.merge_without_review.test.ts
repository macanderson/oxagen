import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { contextPrMerge } from "./context.pr.merge";
import { contextPrMergeWithoutReview } from "./context.pr.merge_without_review";

describe("merge_pr_without_review contract", () => {
  it("registers under its own name", () => {
    expect(getCapability("merge_pr_without_review")).toBe(
      contextPrMergeWithoutReview,
    );
  });

  it("is a governed write that only owners hold by default", () => {
    expect(contextPrMergeWithoutReview.mutates).toBe(true);
    expect(contextPrMergeWithoutReview.noBillingGate).toBe(true);
    expect(contextPrMergeWithoutReview.agent?.requiresApproval).toBe(true);
    expect(contextPrMergeWithoutReview.sensitivity).toBe("high");
    expect(contextPrMergeWithoutReview.defaultEffect).toBe("deny");
    expect(contextPrMergeWithoutReview.defaultRoles).toEqual({
      org: { Owner: "allow" },
      workspace: { Owner: "allow" },
    });
    // The merger is a signed-in user. An API key carries none.
    expect(contextPrMergeWithoutReview.surfaces).toEqual(["api"]);
  });

  it("takes and answers what merge_context_pr does", () => {
    expect(contextPrMergeWithoutReview.input).toBe(contextPrMerge.input);
    expect(contextPrMergeWithoutReview.output).toBe(contextPrMerge.output);
  });
});
