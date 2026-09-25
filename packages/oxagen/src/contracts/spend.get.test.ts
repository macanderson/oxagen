import { describe, expect, it } from "vitest";
import { spendGet, spendRowSchema } from "./spend.get";
import { SPEND_RANGE_DAYS_MAX } from "./spend.shared";

const figure = {
  cost: { micros: "41265", currency: "USD", basis: "gateway_observed" },
  calls: 12,
  runs: 3,
  proven: null,
  accepted: null,
  productiveRatio: null,
};

describe("get_spend contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, default-deny", () => {
    expect(spendGet.mutates).toBe(false);
    expect(spendGet.noBillingGate).toBe(true);
    expect(spendGet.scoped).toBe(true);
    expect(spendGet.defaultEffect).toBe("deny");
    expect(spendGet.layers).not.toContain("e2e");
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(spendGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(spendGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "billing",
    });
  });

  it("takes an inclusive day range and one of the five levels, and nothing else", () => {
    expect(
      spendGet.input.parse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "operator",
      }).groupBy,
    ).toBe("operator");
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-30", to: "2026-09-01" },
        groupBy: "agent",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-02-30", to: "2026-03-01" },
        groupBy: "agent",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "repository",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "tool",
        filter: {},
      }).success,
    ).toBe(false);
  });

  it("caps the range at a quarter, so one read folds at most that many days of runs", () => {
    expect(SPEND_RANGE_DAYS_MAX).toBe(92);
    // 2026-07-01 to 2026-09-30 is 92 days; one more day is refused.
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-07-01", to: "2026-09-30" },
        groupBy: "operator",
      }).success,
    ).toBe(true);
    const over = spendGet.input.safeParse({
      period: { from: "2026-07-01", to: "2026-10-01" },
      groupBy: "operator",
    });
    expect(over.success).toBe(false);
    expect(over.error?.issues.map((i) => i.path)).toEqual([["period", "to"]]);
    expect(
      spendGet.input.safeParse({
        period: { from: "2020-01-01", to: "2099-12-31" },
        groupBy: "operator",
      }).success,
    ).toBe(false);
  });

  it("carries every money figure as micros with a currency and a required basis, or null", () => {
    const row = {
      ...figure,
      key: "acme.core.cc",
      provider: null,
      operator: null,
      tokens: {
        input_uncached: 1,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 1,
        reasoning: 0,
      },
    };
    expect(spendRowSchema.parse(row)).toEqual(row);
    expect(spendRowSchema.parse({ ...row, cost: null }).cost).toBe(null);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: "41265", currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: 41265, currency: "USD", basis: "mixed" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: "0.5", currency: "USD", basis: "estimated" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        proven: { micros: "1", currency: "USD", basis: "mixed" },
      }).success,
    ).toBe(false);
  });
});
