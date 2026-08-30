import { describe, expect, it } from "vitest";
import { workspaceBudgetPolicyWrite } from "./workspace.budget_policy.write";
import { getCapability } from "../registry";

describe("workspace.budget.policy.write capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("update_budget_policy")).toBe(
      workspaceBudgetPolicyWrite,
    );
  });

  it("is workspace-scoped, medium-risk, writable by Owner/Admin only", () => {
    expect(workspaceBudgetPolicyWrite.domain).toBe("workspace");
    expect(workspaceBudgetPolicyWrite.scoped).toBe(true);
    expect(workspaceBudgetPolicyWrite.defaultRoles.workspace.Owner).toBe(
      "allow",
    );
    expect(workspaceBudgetPolicyWrite.defaultRoles.workspace.Admin).toBe(
      "allow",
    );
    // Member and Viewer are not included in defaultRoles.workspace (only Owner/Admin)
    expect(
      Object.keys(workspaceBudgetPolicyWrite.defaultRoles.workspace),
    ).toEqual(["Owner", "Admin"]);
  });

  it("parses an empty input (all optional)", () => {
    expect(workspaceBudgetPolicyWrite.input.parse({})).toEqual({});
  });

  it("parses a full input with all fields", () => {
    const parsed = workspaceBudgetPolicyWrite.input.parse({
      enabled: true,
      limitUsd: 100.0,
      mode: "prompt",
      graceOveragePct: 0.5,
      enforcement: "default",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.limitUsd).toBe(100.0);
    expect(parsed.mode).toBe("prompt");
    expect(parsed.graceOveragePct).toBe(0.5);
    expect(parsed.enforcement).toBe("default");
  });

  it("parses a partial input (only limitUsd)", () => {
    const parsed = workspaceBudgetPolicyWrite.input.parse({
      limitUsd: 25.0,
    });
    expect(parsed.limitUsd).toBe(25.0);
    expect(parsed.enabled).toBeUndefined();
    expect(parsed.mode).toBeUndefined();
  });

  it("parses null limitUsd to clear the limit", () => {
    const parsed = workspaceBudgetPolicyWrite.input.parse({
      limitUsd: null,
    });
    expect(parsed.limitUsd).toBeNull();
  });

  it("rejects negative limitUsd", () => {
    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({
        limitUsd: -1,
      }),
    ).toThrow();
  });

  it("rejects zero limitUsd", () => {
    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({
        limitUsd: 0,
      }),
    ).toThrow();
  });

  it("accepts positive limitUsd", () => {
    const parsed = workspaceBudgetPolicyWrite.input.parse({
      limitUsd: 0.01,
    });
    expect(parsed.limitUsd).toBe(0.01);
  });

  it("validates graceOveragePct is between 0 and 10", () => {
    expect(
      workspaceBudgetPolicyWrite.input.parse({ graceOveragePct: 0 }),
    ).toEqual({ graceOveragePct: 0 });
    expect(
      workspaceBudgetPolicyWrite.input.parse({ graceOveragePct: 10 }),
    ).toEqual({ graceOveragePct: 10 });

    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({ graceOveragePct: -0.1 }),
    ).toThrow();
    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({ graceOveragePct: 10.1 }),
    ).toThrow();
  });

  it("accepts all three valid modes", () => {
    for (const mode of ["grace", "prompt", "enforce"] as const) {
      const parsed = workspaceBudgetPolicyWrite.input.parse({ mode });
      expect(parsed.mode).toBe(mode);
    }
  });

  it("rejects unknown mode", () => {
    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({ mode: "soft-cap" }),
    ).toThrow();
  });

  it("accepts both valid enforcement values", () => {
    for (const enforcement of ["ceiling", "default"] as const) {
      const parsed = workspaceBudgetPolicyWrite.input.parse({ enforcement });
      expect(parsed.enforcement).toBe(enforcement);
    }
  });

  it("rejects unknown enforcement", () => {
    expect(() =>
      workspaceBudgetPolicyWrite.input.parse({ enforcement: "medium" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = workspaceBudgetPolicyWrite.output.parse({
      enabled: true,
      limitUsd: 50.0,
      mode: "grace",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.limitUsd).toBe(50.0);
    expect(parsed.mode).toBe("grace");
    expect(parsed.graceOveragePct).toBe(0.25);
    expect(parsed.enforcement).toBe("ceiling");
  });

  it("output requires all fields", () => {
    expect(() =>
      workspaceBudgetPolicyWrite.output.parse({
        enabled: true,
        limitUsd: 50.0,
        mode: "enforce",
        graceOveragePct: 0.25,
        // missing enforcement
      }),
    ).toThrow();
  });
});
