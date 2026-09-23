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
        state: resolvedBy === null ? "pending" : "approved",
        resolvedBy,
        resolvedByName: null,
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
        state: "approved",
        resolvedBy: "someone",
        resolvedByName: null,
        eligibility: null,
      }).success,
    ).toBe(false);
  });

  // #3521: a mandate revoked or expired after the call was parked closes the
  // request with no resolver, so the state is carried on its own.
  it("carries a settled state with no resolver, and the name of a person who answered", () => {
    const base = {
      approvalId: "apr_0123456789abcdefghjkmn",
      eligibility: null,
    };
    expect(
      approvalAutoEligibilityGet.output.parse({
        ...base,
        state: "expired",
        resolvedBy: null,
        resolvedByName: null,
      }).state,
    ).toBe("expired");
    expect(
      approvalAutoEligibilityGet.output.parse({
        ...base,
        state: "denied",
        resolvedBy: "user:usr_0123456789abcdefghjkmn",
        resolvedByName: "Dana Reyes",
      }).resolvedByName,
    ).toBe("Dana Reyes");
    for (const state of ["waiting", "resolved", ""]) {
      expect(
        approvalAutoEligibilityGet.output.safeParse({
          ...base,
          state,
          resolvedBy: null,
          resolvedByName: null,
        }).success,
      ).toBe(false);
    }
    expect(
      approvalAutoEligibilityGet.output.safeParse({
        ...base,
        resolvedBy: null,
        resolvedByName: null,
      }).success,
    ).toBe(false);
  });
});
