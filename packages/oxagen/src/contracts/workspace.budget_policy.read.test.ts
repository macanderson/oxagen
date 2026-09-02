import { describe, expect, it } from "vitest";
import { workspaceBudgetPolicyRead } from "./workspace.budget_policy.read";
import { getCapability } from "../registry";

describe("workspace.budget.policy.read capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("get_budget_policy")).toBe(workspaceBudgetPolicyRead);
  });

  it("is workspace-scoped, low-risk, readable by all workspace roles", () => {
    expect(workspaceBudgetPolicyRead.domain).toBe("workspace");
    expect(workspaceBudgetPolicyRead.scoped).toBe(true);
    expect(workspaceBudgetPolicyRead.defaultRoles.workspace.Viewer).toBe(
      "allow",
    );
    expect(workspaceBudgetPolicyRead.defaultRoles.workspace.Member).toBe(
      "allow",
    );
  });

  it("parses an empty input", () => {
    expect(workspaceBudgetPolicyRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with all fields", () => {
    const parsed = workspaceBudgetPolicyRead.output.parse({
      enabled: true,
      limitUsd: 50.0,
      mode: "grace",
      graceOveragePct: 0.25,
      enforcement: "default",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.limitUsd).toBe(50.0);
    expect(parsed.mode).toBe("grace");
    expect(parsed.graceOveragePct).toBe(0.25);
    expect(parsed.enforcement).toBe("default");
  });

  it("parses the off-by-default output (no governance)", () => {
    const parsed = workspaceBudgetPolicyRead.output.parse({
      enabled: false,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.limitUsd).toBeNull();
  });

  it("rejects an unknown mode in the output", () => {
    expect(() =>
      workspaceBudgetPolicyRead.output.parse({
        enabled: true,
        limitUsd: 10,
        mode: "soft",
        graceOveragePct: 0.25,
        enforcement: "ceiling",
      }),
    ).toThrow();
  });

  it("rejects an unknown enforcement in the output", () => {
    expect(() =>
      workspaceBudgetPolicyRead.output.parse({
        enabled: true,
        limitUsd: 10,
        mode: "enforce",
        graceOveragePct: 0.25,
        enforcement: "soft-cap",
      }),
    ).toThrow();
  });

  it("accepts all three valid modes", () => {
    for (const mode of ["grace", "prompt", "enforce"] as const) {
      const parsed = workspaceBudgetPolicyRead.output.parse({
        enabled: true,
        limitUsd: 5,
        mode,
        graceOveragePct: 0.25,
        enforcement: "ceiling",
      });
      expect(parsed.mode).toBe(mode);
    }
  });

  it("accepts both valid enforcement values", () => {
    for (const enforcement of ["ceiling", "default"] as const) {
      const parsed = workspaceBudgetPolicyRead.output.parse({
        enabled: true,
        limitUsd: 5,
        mode: "enforce",
        graceOveragePct: 0.25,
        enforcement,
      });
      expect(parsed.enforcement).toBe(enforcement);
    }
  });
});
