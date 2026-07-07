import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffChangedLines, pickTieredAdvisor } from "./index";
import { modelForTier } from "../router/model-router";

describe("diffChangedLines", () => {
  it("counts added and removed lines, ignoring +++/--- file headers", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,3 @@",
      " context",
      "-const a = 1;",
      "+const a = 2;",
      "+const b = 3;",
    ].join("\n");
    // one '-' change + two '+' changes = 3; the ---/+++ headers do not count.
    expect(diffChangedLines(diff)).toBe(3);
  });

  it("returns 0 for an empty diff", () => {
    expect(diffChangedLines("")).toBe(0);
  });
});

describe("pickTieredAdvisor", () => {
  const FAST = modelForTier("fast");
  const PRECISE = modelForTier("precise");

  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env["OXAGEN_LLM_ADVISOR"];
    delete process.env["OXAGEN_JUDGE_FAST_COMPLEXITY_MAX"];
    delete process.env["OXAGEN_DIFF_BUDGET"];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("downgrades a low-complexity, small-diff turn to the fast judge", () => {
    expect(pickTieredAdvisor(PRECISE, 10, 20)).toBe(FAST);
  });

  it("falls through (undefined ⇒ balanced default) for high-complexity work", () => {
    expect(pickTieredAdvisor(PRECISE, 80, 20)).toBeUndefined();
  });

  it("falls through for a large diff even at low complexity", () => {
    expect(pickTieredAdvisor(PRECISE, 10, 500)).toBeUndefined();
  });

  it("never self-grades: returns undefined when the executor already IS the fast tier", () => {
    expect(pickTieredAdvisor(FAST, 10, 20)).toBeUndefined();
  });

  it("an explicit OXAGEN_LLM_ADVISOR always wins (no auto-tiering)", () => {
    process.env["OXAGEN_LLM_ADVISOR"] = "openai/gpt-5.5-pro";
    expect(pickTieredAdvisor(PRECISE, 10, 20)).toBeUndefined();
  });

  it("respects a custom complexity ceiling", () => {
    process.env["OXAGEN_JUDGE_FAST_COMPLEXITY_MAX"] = "5";
    // complexity 10 now exceeds the ceiling of 5 → no downgrade.
    expect(pickTieredAdvisor(PRECISE, 10, 20)).toBeUndefined();
  });

  it("OXAGEN_JUDGE_FAST_COMPLEXITY_MAX=0 disables downgrading entirely", () => {
    process.env["OXAGEN_JUDGE_FAST_COMPLEXITY_MAX"] = "0";
    expect(pickTieredAdvisor(PRECISE, 0, 0)).toBeUndefined();
  });
});
