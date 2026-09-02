import { describe, expect, it } from "vitest";
import { budgetPolicyWrite } from "./budget.policy.write";
import { getCapability } from "../registry";

describe("budget.policy.write capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("update_user_budget")).toBe(budgetPolicyWrite);
  });

  it("is user-scoped, low-risk, no approval", () => {
    expect(budgetPolicyWrite.domain).toBe("user");
    expect(budgetPolicyWrite.scoped).toBe(false);
    expect(budgetPolicyWrite.agent.requiresApproval).toBe(false);
  });

  it("parses an empty input object (no-op update)", () => {
    expect(budgetPolicyWrite.input.parse({})).toEqual({});
  });

  it("parses a full input across all three modes", () => {
    for (const mode of ["grace", "prompt", "enforce"] as const) {
      const parsed = budgetPolicyWrite.input.parse({
        enabled: true,
        limitUsd: 2.5,
        mode,
        graceOveragePct: 0.25,
      });
      expect(parsed.mode).toBe(mode);
      expect(parsed.limitUsd).toBe(2.5);
    }
  });

  it("accepts null to clear the limit", () => {
    const parsed = budgetPolicyWrite.input.parse({ limitUsd: null });
    expect(parsed.limitUsd).toBeNull();
  });

  it("rejects a non-positive limit", () => {
    expect(() => budgetPolicyWrite.input.parse({ limitUsd: 0 })).toThrow();
    expect(() => budgetPolicyWrite.input.parse({ limitUsd: -1 })).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() => budgetPolicyWrite.input.parse({ mode: "soft" })).toThrow();
  });

  it("rejects a grace cushion outside 0..10", () => {
    expect(() =>
      budgetPolicyWrite.input.parse({ graceOveragePct: -0.1 }),
    ).toThrow();
    expect(() =>
      budgetPolicyWrite.input.parse({ graceOveragePct: 11 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = budgetPolicyWrite.output.parse({
      enabled: true,
      limitUsd: 5,
      mode: "enforce",
      graceOveragePct: 0.25,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.mode).toBe("enforce");
  });

  it("accepts null limitUsd in the output", () => {
    const parsed = budgetPolicyWrite.output.parse({
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
    expect(parsed.limitUsd).toBeNull();
  });
});
