/**
 * turn-budget-policy.test.ts: the request schema for the per-turn `budget`
 * field the chat routes accept and ignore (ADR-235 item 10, ADR-277).
 */
import { describe, it, expect } from "vitest";
import { requestTurnBudgetSchema } from "./turn-budget-policy";

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
