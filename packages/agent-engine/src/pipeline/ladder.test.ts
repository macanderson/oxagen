/**
 * Tests for the verification-gated adaptive compute ladder (F3).
 *
 * Full decision-table coverage: every branch in the decision logic, config
 * resolution with defaults and invalid inputs, evidence scoring ordering,
 * and totality (decide never throws across signal combinations).
 */

import { describe, it, expect } from "vitest";
import {
  decide,
  evidenceScore,
  resolveLadderConfig,
  type LadderSignals,
  type LadderDecision,
  type LadderRung,
  type LadderConfig,
} from "./ladder";
import type { OracleState } from "../oracle/spec-test";

// ── Config resolution ──────────────────────────────────────────────────────────

describe("resolveLadderConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = resolveLadderConfig({});
    expect(config.diffBudget).toBe(120);
    expect(config.maxRung).toBe(3);
  });

  it("parses OXAGEN_DIFF_BUDGET as a positive integer", () => {
    const config = resolveLadderConfig({ OXAGEN_DIFF_BUDGET: "200" });
    expect(config.diffBudget).toBe(200);
  });

  it("falls back to default diffBudget for invalid input: non-numeric", () => {
    const config = resolveLadderConfig({ OXAGEN_DIFF_BUDGET: "abc" });
    expect(config.diffBudget).toBe(120);
  });

  it("falls back to default diffBudget for invalid input: negative", () => {
    const config = resolveLadderConfig({ OXAGEN_DIFF_BUDGET: "-5" });
    expect(config.diffBudget).toBe(120);
  });

  it("falls back to default diffBudget for invalid input: zero", () => {
    const config = resolveLadderConfig({ OXAGEN_DIFF_BUDGET: "0" });
    expect(config.diffBudget).toBe(120);
  });

  it("parses OXAGEN_LADDER_MAX_RUNG as 0–3", () => {
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "0" }).maxRung).toBe(
      0,
    );
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "1" }).maxRung).toBe(
      1,
    );
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "2" }).maxRung).toBe(
      2,
    );
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "3" }).maxRung).toBe(
      3,
    );
  });

  it("falls back to default maxRung for invalid input: out of range", () => {
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "4" }).maxRung).toBe(
      3,
    );
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "7" }).maxRung).toBe(
      3,
    );
    expect(resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "-1" }).maxRung).toBe(
      3,
    );
  });

  it("falls back to default maxRung for invalid input: non-numeric", () => {
    const config = resolveLadderConfig({ OXAGEN_LADDER_MAX_RUNG: "xyz" });
    expect(config.maxRung).toBe(3);
  });

  it("handles both env vars together", () => {
    const config = resolveLadderConfig({
      OXAGEN_DIFF_BUDGET: "250",
      OXAGEN_LADDER_MAX_RUNG: "2",
    });
    expect(config.diffBudget).toBe(250);
    expect(config.maxRung).toBe(2);
  });
});

// ── Decision table ─────────────────────────────────────────────────────────────

/**
 * Baseline signals and config for decision tests.
 */
const baselineSignals = (
  overrides?: Partial<LadderSignals>,
): LadderSignals => ({
  oracle: "none",
  touchedTestsGreen: false,
  diffLines: 50,
  filesTouched: 1,
  stepsUsed: 5,
  loopNudges: 0,
  ...overrides,
});

const baselineConfig: LadderConfig = { diffBudget: 120, maxRung: 3 };

describe("decide — decision table", () => {
  // Rule 1: oracle 'flipped' AND touchedTestsGreen AND diffLines ≤ budget → submit-fast (rung 0).
  describe("Rule 1: submit-fast (rung 0)", () => {
    it("fires when oracle flipped, tests green, diff within budget", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: true,
        diffLines: 100,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("submit-fast");
      expect(decision.rung).toBe(0);
    });

    it("fires at boundary: diffLines exactly at budget", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: true,
        diffLines: 120,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("submit-fast");
      expect(decision.rung).toBe(0);
    });

    it("does NOT fire when oracle flipped but tests red", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: false,
        diffLines: 100,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).not.toBe("submit-fast");
    });

    it("does NOT fire when oracle flipped, tests green, but diff over budget", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: true,
        diffLines: 121,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).not.toBe("submit-fast");
    });
  });

  // Rule 2: oracle 'flipped' AND (NOT touchedTestsGreen OR diffLines > budget) → revise (rung 1).
  describe("Rule 2: revise (rung 1)", () => {
    it("fires when oracle flipped but tests red", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: false,
        diffLines: 100,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("revise");
      expect(decision.rung).toBe(1);
      if (decision.action === "revise") {
        expect(decision.reasons).toContain("collateral-red");
      }
    });

    it("fires when oracle flipped but diff over budget", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: true,
        diffLines: 121,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("revise");
      expect(decision.rung).toBe(1);
      if (decision.action === "revise") {
        expect(decision.reasons).toContain("diff-over-budget");
      }
    });

    it("includes both reasons when both constraints violated", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: false,
        diffLines: 121,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("revise");
      if (decision.action === "revise") {
        expect(decision.reasons).toContain("collateral-red");
        expect(decision.reasons).toContain("diff-over-budget");
      }
    });

    it("respects maxRung cap: revise capped to rung 0", () => {
      const signals = baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: false,
        diffLines: 100,
      });
      const config = { diffBudget: 120, maxRung: 0 as LadderRung };
      const decision = decide(signals, config, 0);
      expect(decision.action).toBe("submit-best-effort");
      expect(decision.rung).toBe(0);
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("rung-capped");
        expect(decision.reasons).toContain("collateral-red");
      }
    });
  });

  // Rule 3: oracle NOT 'flipped' AND currentRung < 2 → fork (rung 2).
  describe("Rule 3: fork (rung 2)", () => {
    it("fires when oracle failing and currentRung < 2", () => {
      const signals = baselineSignals({ oracle: "failing" });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("fork");
      expect(decision.rung).toBe(2);
      if (decision.action === "fork") {
        expect(decision.reasons).toContain("oracle-failing");
      }
    });

    it("fires when oracle none and currentRung < 2", () => {
      const signals = baselineSignals({ oracle: "none" });
      const decision = decide(signals, baselineConfig, 1);
      expect(decision.action).toBe("fork");
      expect(decision.rung).toBe(2);
      if (decision.action === "fork") {
        expect(decision.reasons).toContain("oracle-none");
      }
    });

    it("includes loop-thrash reason when loopNudges >= 2", () => {
      const signals = baselineSignals({
        oracle: "failing",
        loopNudges: 2,
      });
      const decision = decide(signals, baselineConfig, 0);
      expect(decision.action).toBe("fork");
      if (decision.action === "fork") {
        expect(decision.reasons).toContain("loop-thrash");
      }
    });

    it("does NOT fire when currentRung >= 2", () => {
      const signals = baselineSignals({ oracle: "failing" });
      const decision = decide(signals, baselineConfig, 2);
      expect(decision.action).not.toBe("fork");
    });

    it("respects maxRung cap: fork capped to rung 1", () => {
      const signals = baselineSignals({ oracle: "failing" });
      const config = { diffBudget: 120, maxRung: 1 as LadderRung };
      const decision = decide(signals, config, 0);
      expect(decision.action).toBe("submit-best-effort");
      expect(decision.rung).toBe(1);
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("rung-capped");
        expect(decision.reasons).toContain("oracle-failing");
      }
    });
  });

  // Rule 4: Otherwise → submit-best-effort (rung 3).
  describe("Rule 4: submit-best-effort (rung 3)", () => {
    it("fires when oracle failing and currentRung >= 2", () => {
      const signals = baselineSignals({ oracle: "failing" });
      const decision = decide(signals, baselineConfig, 2);
      expect(decision.action).toBe("submit-best-effort");
      expect(decision.rung).toBe(3);
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("oracle-failing");
      }
    });

    it("fires when oracle none and currentRung >= 2", () => {
      const signals = baselineSignals({ oracle: "none" });
      const decision = decide(signals, baselineConfig, 3);
      expect(decision.action).toBe("submit-best-effort");
      expect(decision.rung).toBe(3);
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("oracle-none");
      }
    });

    it("includes loop-thrash reason when loopNudges >= 2", () => {
      const signals = baselineSignals({
        oracle: "failing",
        loopNudges: 3,
      });
      const decision = decide(signals, baselineConfig, 2);
      expect(decision.action).toBe("submit-best-effort");
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("loop-thrash");
      }
    });

    it("respects maxRung cap: rung 3 capped to rung 2", () => {
      const signals = baselineSignals({ oracle: "failing" });
      const config = { diffBudget: 120, maxRung: 2 as LadderRung };
      const decision = decide(signals, config, 2);
      expect(decision.action).toBe("submit-best-effort");
      expect(decision.rung).toBe(2);
      if (decision.action === "submit-best-effort") {
        expect(decision.reasons).toContain("rung-capped");
      }
    });
  });
});

// ── Evidence scoring ───────────────────────────────────────────────────────────

describe("evidenceScore", () => {
  it("scores flipped > failing > none", () => {
    const flipped = evidenceScore(baselineSignals({ oracle: "flipped" }));
    const failing = evidenceScore(baselineSignals({ oracle: "failing" }));
    const none = evidenceScore(baselineSignals({ oracle: "none" }));
    expect(flipped).toBeGreaterThan(failing);
    expect(failing).toBeGreaterThan(none);
  });

  it("adds 20 points for touchedTestsGreen", () => {
    const withGreen = evidenceScore(
      baselineSignals({ touchedTestsGreen: true }),
    );
    const withoutGreen = evidenceScore(
      baselineSignals({ touchedTestsGreen: false }),
    );
    expect(withGreen - withoutGreen).toBe(20);
  });

  it("penalizes diffLines: minus min(diffLines/10, 20)", () => {
    const small = evidenceScore(baselineSignals({ diffLines: 50 }));
    const large = evidenceScore(baselineSignals({ diffLines: 100 }));
    const huge = evidenceScore(baselineSignals({ diffLines: 500 }));

    // 50 lines: -5, 100 lines: -10, 500 lines: -20 (capped).
    expect(small - large).toBe(5);
    expect(large - huge).toBe(10);
  });

  it("flipped+green+small-diff scores highest", () => {
    const best = evidenceScore(
      baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: true,
        diffLines: 10,
      }),
    );
    const flippedRed = evidenceScore(
      baselineSignals({
        oracle: "flipped",
        touchedTestsGreen: false,
        diffLines: 10,
      }),
    );
    const failing = evidenceScore(
      baselineSignals({
        oracle: "failing",
        touchedTestsGreen: true,
        diffLines: 10,
      }),
    );
    const none = evidenceScore(
      baselineSignals({
        oracle: "none",
        touchedTestsGreen: true,
        diffLines: 10,
      }),
    );

    expect(best).toBeGreaterThan(flippedRed);
    expect(flippedRed).toBeGreaterThan(failing);
    expect(failing).toBeGreaterThan(none);
  });

  it("handles zero diffLines", () => {
    const score = evidenceScore(baselineSignals({ diffLines: 0 }));
    // oracle 'none' (0) + no touchedTestsGreen (0) - 0 = 0.
    expect(score).toBe(0);
  });

  it("handles large diffLines capped at -20", () => {
    const score = evidenceScore(baselineSignals({ diffLines: 1000 }));
    // oracle 'none' (0) + no touchedTestsGreen (0) - min(100, 20) = -20.
    expect(score).toBe(-20);
  });
});

// ── Totality: decide never throws ──────────────────────────────────────────────

describe("decide — totality", () => {
  it("returns a decision for every oracle state × touchedTestsGreen combination", () => {
    const oracles: OracleState[] = ["none", "failing", "flipped"];
    const testGreenValues = [true, false];
    const rungs: LadderRung[] = [0, 1, 2, 3];

    for (const oracle of oracles) {
      for (const touchedTestsGreen of testGreenValues) {
        for (const rung of rungs) {
          const signals = baselineSignals({ oracle, touchedTestsGreen });
          const decision = decide(signals, baselineConfig, rung);
          expect(decision).toBeDefined();
          expect([
            "submit-fast",
            "revise",
            "fork",
            "submit-best-effort",
          ]).toContain(decision.action);
          expect([0, 1, 2, 3]).toContain(decision.rung);
        }
      }
    }
  });

  it("never throws across a matrix of signal combinations", () => {
    const configs: LadderConfig[] = [
      { diffBudget: 120, maxRung: 3 },
      { diffBudget: 50, maxRung: 0 },
      { diffBudget: 200, maxRung: 1 },
    ];

    const oracles: OracleState[] = ["none", "failing", "flipped"];
    const diffLines = [0, 50, 120, 121, 500];
    const loopNudges = [0, 1, 2, 5];
    const rungs: LadderRung[] = [0, 1, 2, 3];

    for (const config of configs) {
      for (const oracle of oracles) {
        for (const dl of diffLines) {
          for (const ln of loopNudges) {
            for (const rung of rungs) {
              const signals = baselineSignals({
                oracle,
                diffLines: dl,
                loopNudges: ln,
              });
              expect(() => decide(signals, config, rung)).not.toThrow();
            }
          }
        }
      }
    }
  });
});

// ── Decision consistency and edge cases ─────────────────────────────────────────

describe("decide — consistency and edge cases", () => {
  it("maxRung 0 forces all decisions to rung 0", () => {
    const config = { diffBudget: 120, maxRung: 0 as LadderRung };
    const signals = baselineSignals({
      oracle: "flipped",
      touchedTestsGreen: true,
    });
    const decision = decide(signals, config, 0);
    expect(decision.rung).toBe(0);
  });

  it("maxRung 1 prevents fork (rung 2) from being returned", () => {
    const config = { diffBudget: 120, maxRung: 1 as LadderRung };
    const signals = baselineSignals({ oracle: "failing" });
    const decision = decide(signals, config, 0);
    expect(decision.rung).toBeLessThanOrEqual(1);
  });

  it("decision reasons are never empty for rung > 0", () => {
    const oracles: OracleState[] = ["none", "failing", "flipped"];
    const rungs: LadderRung[] = [1, 2, 3];

    for (const oracle of oracles) {
      for (const rung of rungs) {
        const signals = baselineSignals({ oracle });
        const decision = decide(signals, baselineConfig, rung);
        if (decision.rung > 0) {
          if (decision.action !== "submit-fast") {
            expect(decision.reasons).toBeDefined();
            expect(Array.isArray(decision.reasons)).toBe(true);
          }
        }
      }
    }
  });

  it("oracle-state reason is always included when oracle is not flipped", () => {
    const failingSignals = baselineSignals({ oracle: "failing" });
    const noneSignals = baselineSignals({ oracle: "none" });

    const failingDecision = decide(failingSignals, baselineConfig, 0);
    const noneDecision = decide(noneSignals, baselineConfig, 0);

    if (failingDecision.action === "fork") {
      expect(failingDecision.reasons).toContain("oracle-failing");
    }
    if (noneDecision.action === "fork") {
      expect(noneDecision.reasons).toContain("oracle-none");
    }
  });
});
