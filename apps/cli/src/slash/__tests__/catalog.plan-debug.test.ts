/**
 * The /plan and /debug builtin catalog entries (wired in interactive.tsx).
 * Membership + grouping only — behavior is proven by
 * repl/__tests__/interactive.plan-debug.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_SLASH_COMMANDS, BUILTIN_SLASH_NAMES } from "../catalog.js";

describe("catalog — /plan and /debug builtins", () => {
  it("registers /plan with its mode/run argument hint", () => {
    expect(BUILTIN_SLASH_NAMES.has("plan")).toBe(true);
    const plan = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "plan");
    expect(plan?.argumentHint).toBe("[on|off|status|run]");
    expect(plan?.description).toMatch(/plan-only/i);
  });

  it("registers /debug with its toggle hint", () => {
    expect(BUILTIN_SLASH_NAMES.has("debug")).toBe(true);
    const debug = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "debug");
    expect(debug?.argumentHint).toBe("[on|off|status]");
    expect(debug?.description).toMatch(/debug/i);
  });

  it("groups them with their siblings (plan in turn-config, debug by verbose)", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    // /plan sits in the turn-configuration group, right after /pipeline.
    expect(names.indexOf("plan")).toBe(names.indexOf("pipeline") + 1);
    // /debug sits immediately after /verbose, its closest sibling.
    expect(names.indexOf("debug")).toBe(names.indexOf("verbose") + 1);
  });
});
