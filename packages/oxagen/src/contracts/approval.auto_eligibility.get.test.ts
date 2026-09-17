import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { approvalAutoEligibilityGet } from "./approval.auto_eligibility.get";

describe("get_auto_eligibility contract", () => {
  it("is a console read every member of the org may make", () => {
    expect(getCapability("get_auto_eligibility")).toBe(
      approvalAutoEligibilityGet,
    );
    expect(approvalAutoEligibilityGet.mutates).toBe(false);
    expect(approvalAutoEligibilityGet.noBillingGate).toBe(true);
    expect(approvalAutoEligibilityGet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
    });
  });

  it("takes an approval id in either form", () => {
    for (const approvalId of [
      "apr_0123456789abcdefghjkmn",
      "3f1b1d8e-7a2c-4c8f-9f6a-1b2c3d4e5f60",
    ]) {
      expect(approvalAutoEligibilityGet.input.parse({ approvalId })).toEqual({
        approvalId,
      });
    }
    expect(
      approvalAutoEligibilityGet.input.safeParse({ approvalId: "nope" })
        .success,
    ).toBe(false);
  });

  it("carries the approver in the two forms a receipt prints, and the recorded reasons", () => {
    const out = (resolvedBy: string | null) =>
      approvalAutoEligibilityGet.output.parse({
        approvalId: "apr_0123456789abcdefghjkmn",
        resolvedBy,
        eligibility: {
          ruleId: "small-vendor-payments",
          ok: false,
          reasons: ["tainted_input"],
          floor: true,
        },
      });
    expect(out("policy:small-vendor-payments").resolvedBy).toBe(
      "policy:small-vendor-payments",
    );
    expect(out("user:usr_0123456789abcdefghjkmn").resolvedBy).toBe(
      "user:usr_0123456789abcdefghjkmn",
    );
    expect(out(null).resolvedBy).toBeNull();
    expect(
      approvalAutoEligibilityGet.output.safeParse({
        approvalId: "apr_0123456789abcdefghjkmn",
        resolvedBy: "someone",
        eligibility: null,
      }).success,
    ).toBe(false);
  });
});
