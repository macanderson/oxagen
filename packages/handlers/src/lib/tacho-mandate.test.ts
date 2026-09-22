import { describe, expect, it } from "vitest";
import {
  decisionRuleToHarnessRule,
  deriveBundleBudget,
  mapMandateToBundlePermissions,
  mcpRuleToHarnessRule,
} from "./tacho-mandate";

describe("mcpRuleToHarnessRule (tool RBAC)", () => {
  it("maps a server:tool pattern verbatim onto the harness's mcp__server__tool syntax", () => {
    expect(
      mcpRuleToHarnessRule({ pattern: "github:create_issue", effect: "deny" }),
    ).toEqual({ rule: "mcp__github__create_issue", effect: "deny" });
  });

  it("maps a server:* pattern onto an explicit __* suffix rather than the bare-server form", () => {
    expect(
      mcpRuleToHarnessRule({ pattern: "github:*", effect: "allow" }),
    ).toEqual({ rule: "mcp__github__*", effect: "allow" });
  });

  it("passes an ask effect through unchanged", () => {
    expect(
      mcpRuleToHarnessRule({ pattern: "github:delete_*", effect: "ask" }),
    ).toEqual({ rule: "mcp__github__delete_*", effect: "ask" });
  });

  it("defaults the tool segment to * when the pattern names no tool", () => {
    expect(mcpRuleToHarnessRule({ pattern: "github", effect: "deny" })).toEqual(
      { rule: "mcp__github__*", effect: "deny" },
    );
  });
});

describe("decisionRuleToHarnessRule (external-tool rules)", () => {
  it("maps a global deny rule (capability: '*') onto a deny-all mcp rule", () => {
    expect(
      decisionRuleToHarnessRule({ capability: "*", effect: "deny" }),
    ).toEqual({ rule: "mcp__*", effect: "deny" });
  });

  it("maps an mcp.* require_approval rule onto ask", () => {
    expect(
      decisionRuleToHarnessRule({
        capability: "mcp.*",
        effect: "require_approval",
      }),
    ).toEqual({ rule: "mcp__*", effect: "ask" });
  });

  it("does not translate a per-server rule, whose capability names an internal server id the harness cannot resolve", () => {
    expect(
      decisionRuleToHarnessRule({
        capability: "mcp.9f2c1e40-server.create_issue",
        effect: "deny",
      }),
    ).toBeUndefined();
  });

  it("does not translate a business-capability rule unrelated to any tool call", () => {
    expect(
      decisionRuleToHarnessRule({ capability: "issue_refund", effect: "deny" }),
    ).toBeUndefined();
  });
});

describe("mapMandateToBundlePermissions", () => {
  it("returns empty permission arrays for a mandate that names no rules of either kind", () => {
    expect(
      mapMandateToBundlePermissions({ mcpRules: [], externalToolRules: [] }),
    ).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("buckets a tool RBAC rule and an external-tool rule by effect, preserving append order", () => {
    const permissions = mapMandateToBundlePermissions({
      mcpRules: [
        { pattern: "github:*", effect: "allow" },
        { pattern: "slack:delete_*", effect: "deny" },
      ],
      externalToolRules: [{ capability: "mcp.*", effect: "require_approval" }],
    });
    expect(permissions).toEqual({
      allow: ["mcp__github__*"],
      deny: ["mcp__slack__delete_*"],
      ask: ["mcp__*"],
    });
  });

  it("drops an external-tool rule that does not translate, without dropping the ones that do", () => {
    const permissions = mapMandateToBundlePermissions({
      mcpRules: [],
      externalToolRules: [
        { capability: "issue_refund", effect: "deny" },
        { capability: "*", effect: "deny" },
      ],
    });
    expect(permissions).toEqual({ allow: [], deny: ["mcp__*"], ask: [] });
  });
});

describe("deriveBundleBudget", () => {
  it("stays observed with no limit fields when the agent's config carries no budget at all", () => {
    expect(deriveBundleBudget(undefined)).toEqual({ mode: "observed" });
  });

  it("stays observed when the budget table exists but names neither figure", () => {
    expect(deriveBundleBudget({})).toEqual({ mode: "observed" });
  });

  it("enforces a session limit from per_run_micros, converted to USD", () => {
    expect(deriveBundleBudget({ perRunMicros: 2_500_000 })).toEqual({
      mode: "enforced",
      session_limit_usd: 2.5,
    });
  });

  it("enforces a daily limit from per_day_micros, converted to USD", () => {
    expect(deriveBundleBudget({ perDayMicros: 20_000_000 })).toEqual({
      mode: "enforced",
      daily_limit_usd: 20,
    });
  });

  it("carries both limits when the agent's config declares both", () => {
    expect(
      deriveBundleBudget({ perRunMicros: 2_500_000, perDayMicros: 20_000_000 }),
    ).toEqual({
      mode: "enforced",
      session_limit_usd: 2.5,
      daily_limit_usd: 20,
    });
  });

  it("does not invent a limit from a zero or negative figure", () => {
    expect(deriveBundleBudget({ perRunMicros: 0, perDayMicros: -1 })).toEqual({
      mode: "observed",
    });
  });
});
