import { describe, it, expect } from "vitest";
import {
  BudgetExceededError,
  evaluateSpendBudget,
  formatMicrosUsd,
  isBudgetExceeded,
  reachedSpendThreshold,
  spendBudgetWindow,
  SPEND_BUDGET_THRESHOLDS,
} from "./spend-budget";

describe("spendBudgetWindow", () => {
  it("monthly → first instant of the current UTC month .. now", () => {
    const now = new Date("2026-07-21T13:45:12.000Z");
    const w = spendBudgetWindow("monthly", null, now);
    expect(w.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(w.end).toBe(now);
  });

  it("monthly ignores windowDays", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const w = spendBudgetWindow("monthly", 7, now);
    expect(w.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rolling → now − windowDays .. now", () => {
    const now = new Date("2026-07-21T00:00:00.000Z");
    const w = spendBudgetWindow("rolling", 7, now);
    expect(w.start.toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("rolling with missing/non-positive windowDays falls back to 30 days", () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    expect(spendBudgetWindow("rolling", null, now).start.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(spendBudgetWindow("rolling", 0, now).start.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });
});

describe("reachedSpendThreshold", () => {
  it("returns 0 under 50%", () => {
    expect(reachedSpendThreshold(0)).toBe(0);
    expect(reachedSpendThreshold(0.49)).toBe(0);
  });
  it("climbs the ladder at each rung", () => {
    expect(reachedSpendThreshold(0.5)).toBe(50);
    expect(reachedSpendThreshold(0.79)).toBe(50);
    expect(reachedSpendThreshold(0.8)).toBe(80);
    expect(reachedSpendThreshold(0.95)).toBe(95);
    expect(reachedSpendThreshold(0.99)).toBe(95);
    expect(reachedSpendThreshold(1)).toBe(100);
    expect(reachedSpendThreshold(2.5)).toBe(100);
  });
  it("ladder is 50/80/95/100", () => {
    expect([...SPEND_BUDGET_THRESHOLDS]).toEqual([50, 80, 95, 100]);
  });
});

describe("evaluateSpendBudget", () => {
  it("under 50% → ok, not over limit", () => {
    const v = evaluateSpendBudget({ spentMicros: 100n, limitMicros: 1000n });
    expect(v.state).toBe("ok");
    expect(v.overLimit).toBe(false);
    expect(v.reachedThreshold).toBe(0);
    expect(v.ratio).toBeCloseTo(0.1);
  });

  it("soft thresholds map to states without denying", () => {
    expect(
      evaluateSpendBudget({ spentMicros: 500n, limitMicros: 1000n }).state,
    ).toBe("threshold_50");
    expect(
      evaluateSpendBudget({ spentMicros: 800n, limitMicros: 1000n }).state,
    ).toBe("threshold_80");
    expect(
      evaluateSpendBudget({ spentMicros: 960n, limitMicros: 1000n }).state,
    ).toBe("threshold_95");
    for (const spent of [500n, 800n, 960n]) {
      expect(
        evaluateSpendBudget({ spentMicros: spent, limitMicros: 1000n })
          .overLimit,
      ).toBe(false);
    }
  });

  it("over limit is inclusive: spent === limit denies (before this call's own cost)", () => {
    const v = evaluateSpendBudget({ spentMicros: 1000n, limitMicros: 1000n });
    expect(v.state).toBe("exceeded");
    expect(v.overLimit).toBe(true);
    expect(v.reachedThreshold).toBe(100);
  });

  it("non-positive limit is treated as unbounded (defence in depth)", () => {
    const v = evaluateSpendBudget({ spentMicros: 9_999n, limitMicros: 0n });
    expect(v.overLimit).toBe(false);
    expect(v.state).toBe("ok");
  });
});

describe("BudgetExceededError", () => {
  it("carries a stable code and scope detail; message names the capability", () => {
    const err = new BudgetExceededError({
      scope: "workspace",
      orgId: "org-1",
      workspaceId: "ws-1",
      period: "monthly",
      limitMicros: 5_000_000n,
      spentMicros: 5_100_000n,
      capability: "run_workflow",
    });
    expect(err.code).toBe("budget_exceeded");
    expect(err.name).toBe("BudgetExceededError");
    expect(err.scope).toBe("workspace");
    expect(err.message).toContain("run_workflow");
    expect(err.message).toContain("$5.00");
    expect(isBudgetExceeded(err)).toBe(true);
  });

  it("isBudgetExceeded duck-types by code (cross-package boundary)", () => {
    expect(isBudgetExceeded({ code: "budget_exceeded" })).toBe(true);
    expect(isBudgetExceeded({ code: "insufficient_credits" })).toBe(false);
    expect(isBudgetExceeded(null)).toBe(false);
    expect(isBudgetExceeded(new Error("plain"))).toBe(false);
  });
});

describe("formatMicrosUsd", () => {
  it("formats dollars and sub-dollar amounts", () => {
    expect(formatMicrosUsd(1_250_000n)).toBe("$1.25");
    expect(formatMicrosUsd(0n)).toBe("$0.00");
    expect(formatMicrosUsd(3_400n)).toBe("$0.0034");
    expect(formatMicrosUsd(2_100_000_000n)).toBe("$2100.00");
  });
});
