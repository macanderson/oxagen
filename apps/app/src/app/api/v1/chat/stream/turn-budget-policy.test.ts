/**
 * turn-budget-policy.test.ts — unit tests for the pure per-turn budget
 * resolution helper: an explicit per-turn request override always wins;
 * omitting it falls back to the caller-supplied saved default.
 */
import { describe, it, expect } from "vitest";
import {
  requestTurnBudgetSchema,
  resolveTurnBudgetPolicy,
  turnBudgetPolicyFromSaved,
  type RequestTurnBudget,
  type SavedBudgetPolicy,
} from "./turn-budget-policy";
import { TURN_BUDGET_OFF } from "@oxagen/billing";

describe("requestTurnBudgetSchema", () => {
  it("accepts a valid enabled budget", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: 1.5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid disabled budget with limitUsd: null", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(true);
  });

  it("rejects enabled: true with limitUsd: null", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(false);
  });

  it("rejects enabled: true with a non-positive limitUsd", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: 0,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(false);
  });

  it("rejects enabled: true with a negative limitUsd", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: -5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    const result = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: 1,
      mode: "yolo",
      graceOveragePct: 0.25,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a graceOveragePct outside [0, 10]", () => {
    const tooHigh = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: 1,
      mode: "grace",
      graceOveragePct: 11,
    });
    expect(tooHigh.success).toBe(false);

    const tooLow = requestTurnBudgetSchema.safeParse({
      enabled: true,
      limitUsd: 1,
      mode: "grace",
      graceOveragePct: -0.1,
    });
    expect(tooLow.success).toBe(false);
  });
});

describe("resolveTurnBudgetPolicy", () => {
  it("falls back to the saved default when the request omits budget (null)", () => {
    const saved = turnBudgetPolicyFromSaved({
      enabled: true,
      limitUsd: 2.5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(resolveTurnBudgetPolicy(null, saved)).toEqual(saved);
  });

  it("falls back to TURN_BUDGET_OFF when there is no saved default either", () => {
    expect(resolveTurnBudgetPolicy(null, TURN_BUDGET_OFF)).toEqual(TURN_BUDGET_OFF);
  });

  it("an explicit per-turn override wins over the saved default", () => {
    const saved = turnBudgetPolicyFromSaved({
      enabled: true,
      limitUsd: 2.5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    const requestBudget: RequestTurnBudget = {
      enabled: true,
      limitUsd: 0.5,
      mode: "prompt",
      graceOveragePct: 0.1,
    };
    expect(resolveTurnBudgetPolicy(requestBudget, saved)).toEqual({
      enabled: true,
      limitUsd: 0.5,
      mode: "prompt",
      graceOveragePct: 0.1,
    });
  });

  it("an explicit per-turn override can turn the budget OFF even when a saved default is enabled", () => {
    const saved = turnBudgetPolicyFromSaved({
      enabled: true,
      limitUsd: 2.5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    const requestBudget: RequestTurnBudget = {
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    };
    const resolved = resolveTurnBudgetPolicy(requestBudget, saved);
    expect(resolved.enabled).toBe(false);
    expect(resolved.limitUsd).toBe(0);
  });

  it("normalizes limitUsd to 0 when the request budget is disabled, regardless of limitUsd", () => {
    // Defensive: a disabled budget must never carry a stale limit into the
    // guard, even if the client sent a stray limitUsd alongside enabled:false.
    const requestBudget: RequestTurnBudget = {
      enabled: false,
      limitUsd: 99,
      mode: "grace",
      graceOveragePct: 0.25,
    };
    expect(resolveTurnBudgetPolicy(requestBudget, TURN_BUDGET_OFF).limitUsd).toBe(0);
  });

  it("normalizes a null limitUsd to 0 when the request budget is enabled", () => {
    const requestBudget: RequestTurnBudget = {
      enabled: true,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
    };
    expect(resolveTurnBudgetPolicy(requestBudget, TURN_BUDGET_OFF).limitUsd).toBe(0);
  });
});

describe("turnBudgetPolicyFromSaved", () => {
  it("maps a null limitUsd (no limit saved) to 0", () => {
    const saved: SavedBudgetPolicy = {
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    };
    expect(turnBudgetPolicyFromSaved(saved)).toEqual({
      enabled: false,
      limitUsd: 0,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
  });
});
