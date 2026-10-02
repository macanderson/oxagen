import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { steeringPrMerge } from "./steering.pr.merge";
import { steeringPrMergeWithoutReview } from "./steering.pr.merge_without_review";

describe("merge_pr_without_review contract", () => {
  it("registers under its own name", () => {
    expect(getCapability("merge_pr_without_review")).toBe(
      steeringPrMergeWithoutReview,
    );
  });

  it("is a governed write that only owners hold by default", () => {
    expect(steeringPrMergeWithoutReview.mutates).toBe(true);
    expect(steeringPrMergeWithoutReview.noBillingGate).toBe(true);
    expect(steeringPrMergeWithoutReview.agent?.requiresApproval).toBe(true);
    expect(steeringPrMergeWithoutReview.sensitivity).toBe("high");
    expect(steeringPrMergeWithoutReview.defaultEffect).toBe("deny");
    expect(steeringPrMergeWithoutReview.defaultRoles).toEqual({
      org: { Owner: "allow" },
      workspace: { Owner: "allow" },
    });
    // The merger is a signed-in user. An API key carries none.
    expect(steeringPrMergeWithoutReview.surfaces).toEqual(["api", "agent"]);
  });

  it("takes and answers what merge_steering_pr does", () => {
    expect(steeringPrMergeWithoutReview.input).toBe(steeringPrMerge.input);
    expect(steeringPrMergeWithoutReview.output).toBe(steeringPrMerge.output);
  });
});
