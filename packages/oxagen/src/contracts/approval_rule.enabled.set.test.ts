import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { approvalRuleEnabledSet } from "./approval_rule.enabled.set";

describe("set_approval_rule_enabled contract", () => {
  it("is a governance write with the same roles as the set that created the rule", () => {
    expect(getCapability("set_approval_rule_enabled")).toBe(
      approvalRuleEnabledSet,
    );
    expect(approvalRuleEnabledSet.mutates).toBe(true);
    expect(approvalRuleEnabledSet.noBillingGate).toBe(true);
    expect(approvalRuleEnabledSet.agent?.requiresApproval).toBe(true);
    expect(approvalRuleEnabledSet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("takes a rule id and the state to put it in", () => {
    expect(
      approvalRuleEnabledSet.input.parse({
        ruleId: "small-vendor",
        enabled: false,
      }),
    ).toEqual({ ruleId: "small-vendor", enabled: false });
    expect(
      approvalRuleEnabledSet.input.safeParse({ ruleId: "small-vendor" })
        .success,
    ).toBe(false);
  });
});
