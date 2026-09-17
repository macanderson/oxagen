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
      limit: { micros: "500000000", currency: "USD" },
    });
    expect(parsed.period).toBe("monthly");
    expect(parsed.limit).toEqual({ micros: "500000000", currency: "USD" });
  });

  it("parses a valid rolling ceiling with a window", () => {
    const parsed = billingBudgetSet.input.parse({
      scope: "workspace",
      enabled: true,
      period: "rolling",
      windowDays: 7,
      limit: { micros: "50000000", currency: "USD" },
    });
    expect(parsed.windowDays).toBe(7);
  });

  it("rejects rolling without a window", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "rolling",
        limit: { micros: "50000000", currency: "USD" },
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
        limit: { micros: "50000000", currency: "USD" },
      }),
    ).toThrow();
  });

  it("rejects a non-positive limit", () => {
    for (const micros of ["0", "-1", "12.5", "1e6"]) {
      expect(() =>
        billingBudgetSet.input.parse({
          scope: "org",
          enabled: true,
          period: "monthly",
          limit: { micros, currency: "USD" },
        }),
      ).toThrow();
    }
  });

  it("rejects a float ceiling: money travels as micros, never as dollars", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "monthly",
        limitUsd: 500,
      }),
    ).toThrow();
  });

  it("rejects a currency the store cannot record", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "org",
        enabled: true,
        period: "monthly",
        limit: { micros: "1000000", currency: "EUR" },
      }),
    ).toThrow(/USD/);
  });

  it("rejects an unknown scope", () => {
    expect(() =>
      billingBudgetSet.input.parse({
        scope: "global",
        enabled: true,
        period: "monthly",
        limit: { micros: "5000000", currency: "USD" },
      }),
    ).toThrow();
  });
});
