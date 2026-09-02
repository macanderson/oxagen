import { describe, it, expect } from "vitest";
import { createSpecTestTracker } from "../oracle/spec-test";
import {
  specGateInstruction,
  shouldInjectSpecGate,
  buildLadderSignals,
  countDiffLines,
  decideLadderPath,
  resolveJudgeSkipEnabled,
  shouldSkipJudgeReadOnly,
} from "./wiring";

describe("specGateInstruction", () => {
  it("returns a non-empty string", () => {
    const instruction = specGateInstruction();
    expect(instruction).toBeTruthy();
    expect(instruction).toContain("Spec gate");
    expect(instruction).toContain("failing");
  });

  it("is deterministic (same output every call)", () => {
    const a = specGateInstruction();
    const b = specGateInstruction();
    expect(a).toBe(b);
  });
});

describe("shouldInjectSpecGate", () => {
  it("returns false when flag is disabled", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    expect(shouldInjectSpecGate(tracker, false)).toBe(false);
  });

  it("returns false when oracle state is 'failing'", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    expect(shouldInjectSpecGate(tracker, true)).toBe(false);
  });

  it("returns false when oracle state is 'flipped'", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    tracker.observe({ command: "pytest", exitCode: 0 });
    expect(shouldInjectSpecGate(tracker, true)).toBe(false);
  });

  it("returns true when flag is enabled AND oracle state is 'none'", () => {
    const tracker = createSpecTestTracker();
    expect(shouldInjectSpecGate(tracker, true)).toBe(true);
  });

  it("returns true even if tests are only passing (never failed)", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 0 });
    tracker.observe({ command: "npm test", exitCode: 0 });
    // State is still 'none' because no failing test was seen
    expect(shouldInjectSpecGate(tracker, true)).toBe(true);
  });
});

describe("countDiffLines", () => {
  it("counts added lines (starting with +, not +++)", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n+added line 1\n+added line 2";
    expect(countDiffLines(diff)).toBe(2);
  });

  it("counts removed lines (starting with -, not ---)", () => {
    const diff =
      "--- a/file.ts\n+++ b/file.ts\n-removed line 1\n-removed line 2";
    expect(countDiffLines(diff)).toBe(2);
  });

  it("counts both additions and removals", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n-old line\n+new line";
    expect(countDiffLines(diff)).toBe(2);
  });

  it("excludes file headers (--- and +++)", () => {
    const diff =
      "--- a/file.ts\n+++ b/file.ts\n+added\n-removed\n--- another/file.ts\n+++ another/file.ts\n+added2";
    // 3 lines changed (2 in first file, 1 in second), not counting headers
    expect(countDiffLines(diff)).toBe(3);
  });

  it("handles empty diff", () => {
    expect(countDiffLines("")).toBe(0);
  });

  it("handles diff with only headers", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts";
    expect(countDiffLines(diff)).toBe(0);
  });

  it("handles context lines (starting with space)", () => {
    const diff = " context line 1\n+added line\n context line 2\n-removed line";
    // Context lines are not counted, only + and - (excluding headers)
    expect(countDiffLines(diff)).toBe(2);
  });

  it("handles multiline diff with various content", () => {
    const diff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 function foo() {
-  return 1;
+  return 2;
+  console.log('added');
 }`;
    // Count: -return 1 (1), +return 2 (1), +console.log (1) = 3 total
    expect(countDiffLines(diff)).toBe(3);
  });
});

describe("buildLadderSignals", () => {
  it("builds signals with oracle state", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 1,
      stepsUsed: 5,
    });
    expect(signals.oracle).toBe("failing");
  });

  it("sets touchedTestsGreen true when all tests pass", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 0 });
    tracker.observe({ command: "npm test", exitCode: 0 });
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 2,
      stepsUsed: 10,
    });
    expect(signals.touchedTestsGreen).toBe(true);
  });

  it("sets touchedTestsGreen false when any test fails", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 0 });
    tracker.observe({ command: "npm test", exitCode: 1 });
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 2,
      stepsUsed: 10,
    });
    expect(signals.touchedTestsGreen).toBe(false);
  });

  it("sets touchedTestsGreen false when no tests have been run", () => {
    const tracker = createSpecTestTracker();
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 0,
      stepsUsed: 0,
    });
    expect(signals.touchedTestsGreen).toBe(false);
  });

  it("counts diff lines correctly", () => {
    const tracker = createSpecTestTracker();
    const diff = "--- a/file.ts\n+++ b/file.ts\n-old\n+new";
    const signals = buildLadderSignals({
      tracker,
      diff,
      filesTouchedCount: 1,
      stepsUsed: 5,
    });
    expect(signals.diffLines).toBe(2);
  });

  it("includes filesTouched count", () => {
    const tracker = createSpecTestTracker();
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 7,
      stepsUsed: 15,
    });
    expect(signals.filesTouched).toBe(7);
  });

  it("includes stepsUsed", () => {
    const tracker = createSpecTestTracker();
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 1,
      stepsUsed: 23,
    });
    expect(signals.stepsUsed).toBe(23);
  });

  it("sets loopNudges to 0 (not used in this phase)", () => {
    const tracker = createSpecTestTracker();
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 1,
      stepsUsed: 5,
    });
    expect(signals.loopNudges).toBe(0);
  });

  it("builds valid signals from a flipped oracle", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    tracker.observe({ command: "pytest", exitCode: 0 });
    const signals = buildLadderSignals({
      tracker,
      diff: "--- a/fix.py\n+++ b/fix.py\n+fix line",
      filesTouchedCount: 1,
      stepsUsed: 8,
    });
    expect(signals.oracle).toBe("flipped");
    expect(signals.touchedTestsGreen).toBe(true);
    expect(signals.diffLines).toBe(1);
  });
});

describe("decideLadderPath", () => {
  it("returns undefined when ladder is disabled", () => {
    const tracker = createSpecTestTracker();
    const signals = buildLadderSignals({
      tracker,
      diff: "",
      filesTouchedCount: 1,
      stepsUsed: 5,
    });
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: false,
    });
    expect(decision).toBeUndefined();
  });

  it("returns a decision when ladder is enabled", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    tracker.observe({ command: "pytest", exitCode: 0 });
    const signals = buildLadderSignals({
      tracker,
      diff: "--- a/file.ts\n+++ b/file.ts\n+line",
      filesTouchedCount: 1,
      stepsUsed: 5,
    });
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: true,
    });
    expect(decision).toBeDefined();
    expect(decision?.action).toBe("submit-fast");
  });

  it("decides submit-fast when oracle flipped, tests green, diff small", () => {
    const tracker = createSpecTestTracker();
    tracker.observe({ command: "pytest", exitCode: 1 });
    tracker.observe({ command: "pytest", exitCode: 0 });
    const signals: Parameters<typeof decideLadderPath>[0]["signals"] = {
      oracle: "flipped",
      touchedTestsGreen: true,
      diffLines: 50,
      filesTouched: 1,
      stepsUsed: 5,
      loopNudges: 0,
    };
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: true,
    });
    expect(decision?.action).toBe("submit-fast");
    expect(decision?.rung).toBe(0);
  });

  it("decides revise when oracle flipped but tests fail", () => {
    const signals: Parameters<typeof decideLadderPath>[0]["signals"] = {
      oracle: "flipped",
      touchedTestsGreen: false,
      diffLines: 50,
      filesTouched: 2,
      stepsUsed: 5,
      loopNudges: 0,
    };
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: true,
    });
    expect(decision?.action).toBe("revise");
    expect(decision?.rung).toBe(1);
  });

  it("decides fork when oracle not flipped and rung < 2", () => {
    const signals: Parameters<typeof decideLadderPath>[0]["signals"] = {
      oracle: "failing",
      touchedTestsGreen: false,
      diffLines: 30,
      filesTouched: 1,
      stepsUsed: 5,
      loopNudges: 0,
    };
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: true,
    });
    expect(decision?.action).toBe("fork");
    expect(decision?.rung).toBe(2);
  });

  it("respects maxRung cap from environment", () => {
    // Save original env value
    const original = process.env["OXAGEN_LADDER_MAX_RUNG"];

    try {
      process.env["OXAGEN_LADDER_MAX_RUNG"] = "1";
      const signals: Parameters<typeof decideLadderPath>[0]["signals"] = {
        oracle: "failing",
        touchedTestsGreen: false,
        diffLines: 30,
        filesTouched: 1,
        stepsUsed: 5,
        loopNudges: 0,
      };
      const decision = decideLadderPath({
        signals,
        currentRung: 0,
        ladderEnabled: true,
      });
      // Normally would be fork (rung 2), but capped to maxRung=1
      expect(decision?.rung).toBeLessThanOrEqual(1);
    } finally {
      if (original === undefined) {
        delete process.env["OXAGEN_LADDER_MAX_RUNG"];
      } else {
        process.env["OXAGEN_LADDER_MAX_RUNG"] = original;
      }
    }
  });

  it("caps currentRung to valid 0–3 range", () => {
    const signals: Parameters<typeof decideLadderPath>[0]["signals"] = {
      oracle: "none",
      touchedTestsGreen: false,
      diffLines: 10,
      filesTouched: 1,
      stepsUsed: 5,
      loopNudges: 0,
    };
    // Even if a theoretical higher rung were passed, it should be capped
    const decision = decideLadderPath({
      signals,
      currentRung: 0,
      ladderEnabled: true,
    });
    expect(decision?.rung).toBeLessThanOrEqual(3);
  });
});

describe("resolveJudgeSkipEnabled (ADR-021 §1 — default ON, opt-out)", () => {
  it("defaults to ON when OXAGEN_LADDER is unset", () => {
    expect(resolveJudgeSkipEnabled({})).toBe(true);
  });

  it("opts OUT on an explicit falsey value", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off"]) {
      expect(resolveJudgeSkipEnabled({ OXAGEN_LADDER: v })).toBe(false);
    }
  });

  it("stays ON for legacy truthy / any other value", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      expect(resolveJudgeSkipEnabled({ OXAGEN_LADDER: v })).toBe(true);
    }
  });
});

describe("shouldSkipJudgeReadOnly", () => {
  it("skips a read-only turn with an empty diff", () => {
    expect(shouldSkipJudgeReadOnly({ readOnly: true, diff: "" })).toBe(true);
    expect(shouldSkipJudgeReadOnly({ readOnly: true, diff: "\n  \n" })).toBe(
      true,
    );
  });

  it("does NOT skip when the turn changed files, even if read-only-flagged", () => {
    expect(
      shouldSkipJudgeReadOnly({
        readOnly: true,
        diff: "--- a/x\n+++ b/x\n+new line",
      }),
    ).toBe(false);
  });

  it("does NOT skip a writable turn", () => {
    expect(shouldSkipJudgeReadOnly({ readOnly: false, diff: "" })).toBe(false);
  });
});

describe("decideLadderPath — failing oracle keeps the judge (does not fast-path)", () => {
  it("returns a non-submit-fast decision when the oracle is failing so the judge runs", () => {
    const decision = decideLadderPath({
      signals: {
        oracle: "failing",
        touchedTestsGreen: false,
        diffLines: 10,
        filesTouched: 1,
        stepsUsed: 3,
        loopNudges: 0,
      },
      currentRung: 0,
      ladderEnabled: true,
    });
    // Not undefined (skip enabled), but NOT submit-fast — so the caller runs the judge.
    expect(decision).toBeDefined();
    expect(decision!.action).not.toBe("submit-fast");
  });
});
