/**
 * Verification-gated adaptive compute ladder (F3).
 *
 * Pure decision module for escalation strategy based on measured signals.
 * No I/O, no external deps, no `any` (TS 6). Exports a decision function that
 * maps signals to ladder rungs (0–3), config resolver from environment, and
 * evidence scoring for tie-breaking.
 *
 * Decision table (first match wins):
 * - oracle 'flipped' AND touchedTestsGreen AND diffLines ≤ budget → submit-fast (rung 0).
 * - oracle 'flipped' AND (NOT touchedTestsGreen OR diffLines > budget) → revise (rung 1).
 * - oracle NOT 'flipped' AND currentRung < 2 → fork (rung 2).
 * - Otherwise → submit-best-effort (rung 3), capped by maxRung.
 */

import type { OracleState } from "../oracle/spec-test";

// ── Signals and decisions ──────────────────────────────────────────────────────

/**
 * All signals come from executed evidence, no LLM.
 */
export interface LadderSignals {
  /** Oracle state: 'none' (no failing test), 'failing' (test failed), 'flipped' (was failing, now passes). */
  oracle: OracleState;
  /** Tests covering touched files pass. */
  touchedTestsGreen: boolean;
  /** Lines changed in working diff. */
  diffLines: number;
  /** Number of files touched. */
  filesTouched: number;
  /** Steps used so far. */
  stepsUsed: number;
  /** Loop-detector interventions this round. */
  loopNudges: number;
}

/**
 * Ladder rungs: 0 = fast path, 1 = revise, 2 = fork, 3 = submit best-effort.
 */
export type LadderRung = 0 | 1 | 2 | 3;

/**
 * Decision output: action and rung, plus reasons for higher rungs.
 *
 * submit-best-effort can have rung 0–3 when capped by maxRung.
 */
export type LadderDecision =
  | { action: "submit-fast"; rung: 0 }
  | { action: "revise"; rung: 1; reasons: string[] }
  | { action: "fork"; rung: 2; reasons: string[] }
  | { action: "submit-best-effort"; rung: LadderRung; reasons: string[] };

// ── Config ─────────────────────────────────────────────────────────────────────

/**
 * Configuration for ladder behavior.
 */
export interface LadderConfig {
  /** Max lines changed before escalating from rung 0 to rung 1. */
  diffBudget: number;
  /** Hard cap on rung (0–3); decisions capped to min(computed, maxRung). */
  maxRung: LadderRung;
}

/**
 * Resolve ladder config from environment variables.
 *
 * - `OXAGEN_DIFF_BUDGET`: positive integer, default 120. Invalid values fall back to default.
 * - `OXAGEN_LADDER_MAX_RUNG`: 0–3, default 3. Invalid values fall back to default.
 *
 * Never throws; invalid inputs silently use defaults.
 */
export function resolveLadderConfig(
  env: Record<string, string | undefined>,
): LadderConfig {
  let diffBudget = 120;
  let maxRung: LadderRung = 3;

  const budgetEnv = env["OXAGEN_DIFF_BUDGET"];
  if (budgetEnv !== undefined) {
    const parsed = Number.parseInt(budgetEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      diffBudget = parsed;
    }
  }

  const maxRungEnv = env["OXAGEN_LADDER_MAX_RUNG"];
  if (maxRungEnv !== undefined) {
    const parsed = Number.parseInt(maxRungEnv, 10);
    if ([0, 1, 2, 3].includes(parsed)) {
      maxRung = parsed as LadderRung;
    }
  }

  return { diffBudget, maxRung };
}

// ── Decision logic ─────────────────────────────────────────────────────────────

/**
 * Decide the next ladder rung based on signals and config.
 *
 * Decision table (first match wins):
 * 1. oracle 'flipped' AND touchedTestsGreen AND diffLines ≤ budget → submit-fast (rung 0).
 * 2. oracle 'flipped' AND (NOT touchedTestsGreen OR diffLines > budget) → revise (rung 1).
 * 3. oracle NOT 'flipped' AND currentRung < 2 → fork (rung 2).
 * 4. Otherwise (or when computed rung exceeds maxRung) → submit-best-effort (rung 3).
 *
 * A decision capped by maxRung includes reason 'rung-capped'.
 *
 * This is a total function: every input combination returns a decision; never throws.
 */
export function decide(
  signals: LadderSignals,
  config: LadderConfig,
  currentRung: LadderRung,
): LadderDecision {
  // Rule 1: oracle 'flipped' AND touchedTestsGreen AND diffLines ≤ budget → submit-fast (rung 0).
  if (
    signals.oracle === "flipped" &&
    signals.touchedTestsGreen &&
    signals.diffLines <= config.diffBudget
  ) {
    return { action: "submit-fast", rung: 0 };
  }

  // Rule 2: oracle 'flipped' AND (NOT touchedTestsGreen OR diffLines > budget) → revise (rung 1).
  if (signals.oracle === "flipped") {
    const reasons: string[] = [];
    if (!signals.touchedTestsGreen) {
      reasons.push("collateral-red");
    }
    if (signals.diffLines > config.diffBudget) {
      reasons.push("diff-over-budget");
    }
    // Ensure we have at least one reason (should always be true given the condition).
    if (reasons.length === 0) {
      reasons.push("oracle-flipped-but-constraints-violated");
    }
    const computedRung: LadderRung = 1;
    if (computedRung > config.maxRung) {
      reasons.push("rung-capped");
      const cappedRung = config.maxRung as LadderRung;
      return {
        action: "submit-best-effort",
        rung: cappedRung,
        reasons,
      };
    }
    return { action: "revise", rung: computedRung, reasons };
  }

  // Rule 3: oracle NOT 'flipped' AND currentRung < 2 → fork (rung 2).
  if (currentRung < 2) {
    const reasons: string[] = [];
    const oracleState = signals.oracle as "none" | "failing"; // Not flipped at this point
    reasons.push(`oracle-${oracleState}`);
    if (signals.loopNudges >= 2) {
      reasons.push("loop-thrash");
    }
    const computedRung: LadderRung = 2;
    if (computedRung > config.maxRung) {
      reasons.push("rung-capped");
      const cappedRung = config.maxRung as LadderRung;
      return {
        action: "submit-best-effort",
        rung: cappedRung,
        reasons,
      };
    }
    return { action: "fork", rung: computedRung, reasons };
  }

  // Rule 4: Otherwise → submit-best-effort (rung 3), capped by maxRung.
  const reasons: string[] = [];
  const oracleState = signals.oracle as "none" | "failing"; // Not flipped at this point
  reasons.push(`oracle-${oracleState}`);
  if (signals.loopNudges >= 2) {
    reasons.push("loop-thrash");
  }
  const computedRung: LadderRung = 3;
  if (computedRung > config.maxRung) {
    reasons.push("rung-capped");
    const cappedRung = config.maxRung as LadderRung;
    return {
      action: "submit-best-effort",
      rung: cappedRung,
      reasons,
    };
  }
  return { action: "submit-best-effort", rung: computedRung, reasons };
}

// ── Evidence scoring ───────────────────────────────────────────────────────────

/**
 * Score signals for best-effort candidate tie-breaking at rung 3.
 *
 * Ordering: flipped=100, failing=40, none=0; +20 when touchedTestsGreen;
 * minus min(diffLines/10, 20).
 *
 * Higher score is better.
 */
export function evidenceScore(signals: LadderSignals): number {
  let score = 0;

  // Oracle state: flipped (100) > failing (40) > none (0).
  if (signals.oracle === "flipped") {
    score += 100;
  } else if (signals.oracle === "failing") {
    score += 40;
  }

  // Touched tests green: +20.
  if (signals.touchedTestsGreen) {
    score += 20;
  }

  // Diff size penalty: minus min(diffLines/10, 20).
  score -= Math.min(Math.floor(signals.diffLines / 10), 20);

  return score;
}
