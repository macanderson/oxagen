import { describe, expect, it } from "vitest";
import { billingBudgetGet } from "./billing.budget.get";
import { getCapability } from "../registry";

describe("billing.budget.get capability", () => {
  it("is registered under get_spend_budget", () => {
    expect(getCapability("get_spend_budget")).toBe(billingBudgetGet);
  });

  it("is org/workspace scoped, low-risk, and exempt from the budget gate", () => {
    expect(billingBudgetGet.domain).toBe("billing");
    expect(billingBudgetGet.scoped).toBe(true);
    expect(billingBudgetGet.noBillingGate).toBe(true);
    expect(billingBudgetGet.agent.riskLevel).toBe("low");
  });

  it("declares the app layer so the panel is parity-tracked", () => {
    expect(billingBudgetGet.layers).toContain("app");
  });

  it("parses an empty input (reads the active scope)", () => {
    expect(billingBudgetGet.input.parse({})).toEqual({});
  });

  it("parses an output with a full budget status entry", () => {
    const parsed = billingBudgetGet.output.parse({
      budgets: [
        {
          scope: "org",
          publicId: "bdg_abc",
          enabled: true,
          period: "monthly",
          windowDays: null,
          limitUsd: 100,
          spentUsd: 42.5,
          projectedUsd: 90,
          ratio: 0.425,
          state: "ok",
          reachedThreshold: 0,
          windowStart: "2026-07-01T00:00:00.000Z",
          windowEnd: "2026-07-21T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.budgets).toHaveLength(1);
    expect(parsed.budgets[0]!.scope).toBe("org");
  });

  it("parses an empty budgets array (no ceilings configured)", () => {
    expect(billingBudgetGet.output.parse({ budgets: [] }).budgets).toEqual([]);
  });

  it("rejects an unknown state", () => {
    expect(() =>
      billingBudgetGet.output.parse({
        budgets: [
          {
            scope: "org",
            publicId: null,
            enabled: false,
            period: "monthly",
            windowDays: null,
            limitUsd: null,
            spentUsd: 0,
            projectedUsd: 0,
            ratio: 0,
            state: "over", // invalid
            reachedThreshold: 0,
            windowStart: "x",
            windowEnd: "y",
          },
        ],
      }),
    ).toThrow();
  });
});
