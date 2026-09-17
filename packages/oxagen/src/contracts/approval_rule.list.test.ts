import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { approvalRuleList } from "./approval_rule.list";

describe("list_approval_rules contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, for the accountable office", () => {
    expect(getCapability("list_approval_rules")).toBe(approvalRuleList);
    expect(approvalRuleList.scoped).toBe(true);
    expect(approvalRuleList.mutates).toBe(false);
    expect(approvalRuleList.noBillingGate).toBe(true);
    expect(approvalRuleList.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
    });
  });

  it("takes no argument and returns each rule with its window counters", () => {
    expect(approvalRuleList.input.parse({})).toEqual({});
    expect(approvalRuleList.input.safeParse({ limit: 10 }).success).toBe(false);
    const rule = {
      id: "small-vendor-payments",
      name: "Small vendor payments",
      tools: ["stripe__create_payment@*"],
      enabled: true,
      maxMeasures: { amount: "250000000" },
      allowTargets: {},
      standingWindowMs: null,
      businessHours: null,
      createdBy: "usr_0123456789abcdefghjkmn",
      createdAt: "2026-09-02T00:00:00.000Z",
      hits30d: 41,
      skipped30d: 6,
    };
    expect(
      approvalRuleList.output.parse({ items: [rule], windowDays: 30 }),
    ).toEqual({ items: [rule], windowDays: 30 });
    expect(
      approvalRuleList.output.safeParse({
        items: [{ ...rule, hits30d: -1 }],
        windowDays: 30,
      }).success,
    ).toBe(false);
  });
});
