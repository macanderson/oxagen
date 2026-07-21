import { describe, expect, it } from "vitest";
import { billingBudgetSet } from "./billing.budget.set";
import { getCapability } from "../registry";

describe("billing.budget.set capability", () => {
  it("is registered under set_spend_budget", () => {
    expect(getCapability("set_spend_budget")).toBe(billingBudgetSet);
  });

  it("is admin/billing-governed, scoped, and exempt from the budget gate", () => {
    expect(billingBudgetSet.domain).toBe("billing");
    expect(billingBudgetSet.scoped).toBe(true);
    expect(billingBudgetSet.noBillingGate).toBe(true);
    // No Member/Viewer allow — setting a ceiling is org governance.
    expect(billingBudgetSet.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
    });
    expect(billingBudgetSet.defaultRoles.org).not.toHaveProperty("Member");
  });

  it("declares the app layer so the panel is parity-tracked", () => {
    expect(billingBudgetSet.layers).toContain("app");
  });

  it("parses a valid monthly ceiling", () => {
    const parsed = billingBudgetSet.input.parse({
      scope: "org",
      enabled: true,
      period: "monthly",
      limitUsd: 500,
    });
    expect(parsed.period).toBe("monthly");
    expect(parsed.limitUsd).toBe(500);
  });

  it("parses a valid rolling ceiling with a window", () => {
    const parsed = billingBudgetSet.input.parse({
      scope: "workspace",
      enabled: true,
      period: "rolling",
      windowDays: 7,
      limitUsd: 50,
    });
    expect(parsed.windowDays).toBe(7);
  });

  it("rejects rolling without a window", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "rolling",
        limitUsd: 50,
      }),
    ).toThrow();
  });

  it("rejects monthly WITH a window", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "monthly",
        windowDays: 30,
        limitUsd: 50,
      }),
    ).toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "monthly",
        limitUsd: 0,
      }),
    ).toThrow();
  });

  it("rejects an unknown scope", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "global",
        enabled: true,
        period: "monthly",
        limitUsd: 5,
      }),
    ).toThrow();
  });
});
