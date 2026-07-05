import { describe, expect, it } from "vitest";
import { budgetPolicyRead } from "./budget.policy.read";
import { getCapability } from "../registry";

describe("budget.policy.read capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("budget.policy.read")).toBe(budgetPolicyRead);
  });

  it("is user-scoped, low-risk, readable by all roles", () => {
    expect(budgetPolicyRead.domain).toBe("user");
    expect(budgetPolicyRead.scoped).toBe(false);
    expect(budgetPolicyRead.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("parses an empty input", () => {
    expect(budgetPolicyRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with a limit set", () => {
    const parsed = budgetPolicyRead.output.parse({
      enabled: true,
      limitUsd: 2.5,
      mode: "grace",
      graceOveragePct: 0.25,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.limitUsd).toBe(2.5);
    expect(parsed.mode).toBe("grace");
  });

  it("parses the off-by-default output (null limit)", () => {
    const parsed = budgetPolicyRead.output.parse({
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
    expect(parsed.limitUsd).toBeNull();
  });

  it("rejects an unknown mode in the output", () => {
    expect(() =>
      budgetPolicyRead.output.parse({
        enabled: true,
        limitUsd: 1,
        mode: "hard",
        graceOveragePct: 0.25,
      }),
    ).toThrow();
  });
});
