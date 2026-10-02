import { describe, expect, it } from "vitest";
import { steeringPrGet } from "./steering.pr.get";
import { steeringPrOpen } from "./steering.pr.open";

describe("get_steering_pr contract", () => {
  it("is the console read that polls the state machine", () => {
    expect(steeringPrGet.name).toBe("get_steering_pr");
    expect(steeringPrGet.mutates).toBe(false);
    expect(steeringPrGet.noBillingGate).toBe(true);
    expect(steeringPrGet.input.safeParse({ proposalId: "prp_1" }).success).toBe(
      true,
    );
  });

  it("answers open_steering_pr's view with the findings and approvals added (#4518)", () => {
    const view = steeringPrOpen.output.shape;
    const read = steeringPrGet.output.shape;
    expect(Object.keys(read).sort()).toEqual(
      [...Object.keys(view), "approvals", "findings"].sort(),
    );
    const finding = {
      rule: "managed-block",
      path: "AGENTS.md",
      line: 3,
      message: "The managed block in AGENTS.md was edited.",
    };
    expect(read.findings.safeParse([finding]).success).toBe(true);
    expect(
      read.findings.safeParse([{ ...finding, rule: "secret-scan" }]).success,
    ).toBe(false);
    expect(read.approvals.safeParse(0).success).toBe(true);
    expect(read.approvals.safeParse(-1).success).toBe(false);
  });
});
