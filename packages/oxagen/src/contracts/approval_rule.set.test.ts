import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { approvalRuleSet } from "./approval_rule.set";

const body = {
  id: "small-vendor-payments",
  name: "Small vendor payments",
  tools: ["stripe__create_payment@*"],
};

describe("set_approval_rules contract", () => {
  it("is a governance write: high sensitivity, Owner and Admin, a person approves an agent's", () => {
    expect(getCapability("set_approval_rules")).toBe(approvalRuleSet);
    expect(approvalRuleSet.mutates).toBe(true);
    expect(approvalRuleSet.scoped).toBe(true);
    expect(approvalRuleSet.noBillingGate).toBe(true);
    expect(approvalRuleSet.sensitivity).toBe("high");
    expect(approvalRuleSet.agent?.requiresApproval).toBe(true);
    expect(approvalRuleSet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("defaults every condition off, so a rule names only what it asks for", () => {
    expect(approvalRuleSet.input.parse({ rules: [body] })).toEqual({
      rules: [
        {
          ...body,
          enabled: true,
          maxMeasures: {},
          allowTargets: {},
          standingWindowMs: null,
          businessHours: null,
        },
      ],
    });
  });

  it("refuses a rule id that is not a slug, a rule with no tool, and an unknown field", () => {
    for (const rules of [
      [{ ...body, id: "Small Vendor Payments" }],
      [{ ...body, tools: [] }],
      [{ ...body, minTrust: 800 }],
      [{ ...body, createdBy: "usr_0123456789abcdefghjkmn" }],
    ]) {
      expect(approvalRuleSet.input.safeParse({ rules }).success).toBe(false);
    }
  });

  it("accepts an empty set — clearing the clause is a write like any other", () => {
    expect(approvalRuleSet.input.parse({ rules: [] })).toEqual({ rules: [] });
  });
});
