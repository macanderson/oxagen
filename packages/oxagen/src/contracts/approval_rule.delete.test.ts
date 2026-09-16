import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { approvalRuleDelete } from "./approval_rule.delete";

describe("delete_approval_rule contract", () => {
  it("is a governance write with the same roles as the set that created the rule", () => {
    expect(getCapability("delete_approval_rule")).toBe(approvalRuleDelete);
    expect(approvalRuleDelete.mutates).toBe(true);
    expect(approvalRuleDelete.noBillingGate).toBe(true);
    expect(approvalRuleDelete.sensitivity).toBe("high");
    expect(approvalRuleDelete.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("takes one rule id as a slug", () => {
    expect(approvalRuleDelete.input.parse({ ruleId: "small-vendor" })).toEqual({
      ruleId: "small-vendor",
    });
    expect(
      approvalRuleDelete.input.safeParse({ ruleId: "Small Vendor" }).success,
    ).toBe(false);
    expect(approvalRuleDelete.input.safeParse({}).success).toBe(false);
  });
});
