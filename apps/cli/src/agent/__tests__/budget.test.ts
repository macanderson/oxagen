/**
 * Unit coverage for the per-turn budget CLI parsing helpers (agent/budget.ts):
 *   - resolveBudgetFlags — `--budget`/`--budget-mode` launch flags
 *   - parseBudgetCommand — the `/budget …` REPL slash-command grammar
 *
 * The evaluator/guard themselves (createTurnBudgetGuard, evaluateTurnBudget)
 * live in @oxagen/billing and are covered there — this file only exercises the
 * CLI-side input parsing built on top of them.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_TURN_BUDGET_MODE } from "@oxagen/billing/turn-budget";
import {
  parseBudgetFlag,
  resolveBudgetFlags,
  parseBudgetCommand,
  describeBudgetModes,
} from "../budget.js";

describe("parseBudgetFlag", () => {
  it("accepts a positive decimal", () => {
    expect(parseBudgetFlag("2.50")).toBe(2.5);
  });

  it("rejects zero, negative, and non-numeric input", () => {
    expect(parseBudgetFlag("0")).toBeNull();
    expect(parseBudgetFlag("-1")).toBeNull();
    expect(parseBudgetFlag("abc")).toBeNull();
    expect(parseBudgetFlag("")).toBeNull();
  });
});

describe("resolveBudgetFlags", () => {
  it("returns no policy when --budget is absent (mode ignored too)", () => {
    expect(resolveBudgetFlags(undefined, "enforce")).toEqual({});
    expect(resolveBudgetFlags(undefined, undefined)).toEqual({});
  });

  it("enables at the default mode when --budget-mode is omitted", () => {
    const { policy, error } = resolveBudgetFlags("2.50", undefined);
    expect(error).toBeUndefined();
    expect(policy).toEqual({
      enabled: true,
      limitUsd: 2.5,
      mode: DEFAULT_TURN_BUDGET_MODE,
      graceOveragePct: 0.25,
    });
  });

  it("resolves an explicit mode, including aliases", () => {
    expect(resolveBudgetFlags("1", "hard").policy?.mode).toBe("enforce");
    expect(resolveBudgetFlags("1", "soft").policy?.mode).toBe("grace");
    expect(resolveBudgetFlags("1", "ask").policy?.mode).toBe("prompt");
  });

  it("errors on an invalid --budget amount", () => {
    const { policy, error } = resolveBudgetFlags("nope", undefined);
    expect(policy).toBeUndefined();
    expect(error).toMatch(/invalid --budget/);
  });

  it("errors on an invalid --budget-mode", () => {
    const { policy, error } = resolveBudgetFlags("2", "bogus");
    expect(policy).toBeUndefined();
    expect(error).toMatch(/invalid --budget-mode/);
  });
});

describe("parseBudgetCommand", () => {
  it("treats empty and 'status' as a status query", () => {
    expect(parseBudgetCommand("")).toEqual({ kind: "status" });
    expect(parseBudgetCommand("   ")).toEqual({ kind: "status" });
    expect(parseBudgetCommand("status")).toEqual({ kind: "status" });
    expect(parseBudgetCommand("STATUS")).toEqual({ kind: "status" });
  });

  it("parses 'off'", () => {
    expect(parseBudgetCommand("off")).toEqual({ kind: "off" });
    expect(parseBudgetCommand(" OFF ")).toEqual({ kind: "off" });
  });

  it("parses 'mode <mode>' without touching the limit", () => {
    expect(parseBudgetCommand("mode enforce")).toEqual({
      kind: "mode",
      mode: "enforce",
    });
    expect(parseBudgetCommand("mode hard")).toEqual({
      kind: "mode",
      mode: "enforce",
    });
    expect(parseBudgetCommand("mode bogus")).toEqual({
      kind: "invalid",
      raw: "mode bogus",
    });
  });

  it("parses '<usd>' with the default mode", () => {
    expect(parseBudgetCommand("2.5")).toEqual({
      kind: "set",
      policy: {
        enabled: true,
        limitUsd: 2.5,
        mode: DEFAULT_TURN_BUDGET_MODE,
        graceOveragePct: 0.25,
      },
    });
  });

  it("parses '<usd> <mode>' with an explicit mode", () => {
    expect(parseBudgetCommand("1 grace")).toEqual({
      kind: "set",
      policy: {
        enabled: true,
        limitUsd: 1,
        mode: "grace",
        graceOveragePct: 0.25,
      },
    });
  });

  it("rejects a non-positive or non-numeric amount", () => {
    expect(parseBudgetCommand("0")).toEqual({ kind: "invalid", raw: "0" });
    expect(parseBudgetCommand("-1")).toEqual({ kind: "invalid", raw: "-1" });
    expect(parseBudgetCommand("abc")).toEqual({ kind: "invalid", raw: "abc" });
  });

  it("rejects an unknown mode after the amount", () => {
    expect(parseBudgetCommand("2 bogus")).toEqual({
      kind: "invalid",
      raw: "2 bogus",
    });
  });

  it("rejects extra tokens", () => {
    expect(parseBudgetCommand("2 grace extra")).toEqual({
      kind: "invalid",
      raw: "2 grace extra",
    });
  });
});

describe("describeBudgetModes", () => {
  it("mentions all three modes", () => {
    const text = describeBudgetModes();
    expect(text).toMatch(/grace/);
    expect(text).toMatch(/prompt/);
    expect(text).toMatch(/enforce/);
  });
});
