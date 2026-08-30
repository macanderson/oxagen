/**
 * Wiring helpers for F2 (spec-first oracle) and F3 (adaptive ladder) integration.
 *
 * Pure functions extracted from the main pipeline loop for testability.
 * No I/O, no external deps, no `any` (TS 6).
 */

import type { SpecTestTracker } from "../oracle/spec-test";
import {
  type LadderSignals,
  type LadderDecision,
  decide,
  resolveLadderConfig,
} from "./ladder";

/**
 * Spec-gate instruction: injected when oracle state is 'none' at mid-judge point.
 * The instruction tells the agent: "Before any further source edits, produce a failing test
 * or repro script that encodes the issue's expected behavior."
 */
export function specGateInstruction(): string {
  return (
    "[Spec gate] No failing reproduction has been executed yet. " +
    "Before any further source edits: write a minimal test or scratch script that encodes " +
    "the issue's expected behavior, run it, and confirm it FAILS on the current code. " +
    "Then patch to flip it."
  );
}

/**
 * Determine whether to skip the mid-judge completeness check and inject
 * the spec-gate instruction instead.
 *
 * Preconditions:
 * - `OXAGEN_SPEC_GATE` env var must be truthy.
 * - `tracker.state()` must be 'none' (no failing test observed yet).
 *
 * When both conditions hold, return true to signal: skip judgeCompleteness,
 * inject specGateInstruction() as the phase B prompt.
 */
export function shouldInjectSpecGate(
  tracker: SpecTestTracker,
  specGateEnabled: boolean,
): boolean {
  return specGateEnabled && tracker.state() === "none";
}

/**
 * Build LadderSignals from the current execution state.
 *
 * All signals are measured from executed evidence:
 * - `oracle`: current spec-test oracle state (from tracker).
 * - `touchedTestsGreen`: true if every distinct test command observed has
 *   a most-recent exit code of 0 (all are currently passing).
 * - `diffLines`: +/− lines in the working diff (excluding +++/--- headers).
 * - `filesTouched`: count of unique files changed.
 * - `stepsUsed`: total steps executed so far this round.
 * - `loopNudges`: unused in this phase; set to 0.
 *
 * Throws never; returns a valid signal even if some inputs are edge-cased.
 */
export function buildLadderSignals(opts: {
  tracker: SpecTestTracker;
  diff: string;
  filesTouchedCount: number;
  stepsUsed: number;
}): LadderSignals {
  // Oracle state.
  const oracle = opts.tracker.state();

  // Touched tests green: true iff every distinct test command's most recent
  // exit code is 0. If no tests have been run, default to false (conservative).
  const outcomes = opts.tracker.lastOutcomes();
  const touchedTestsGreen =
    outcomes.size > 0 &&
    Array.from(outcomes.values()).every((exitCode) => exitCode === 0);

  // Diff line count: sum +/- lines, excluding +++/--- headers.
  const diffLines = countDiffLines(opts.diff);

  return {
    oracle,
    touchedTestsGreen,
    diffLines,
    filesTouched: opts.filesTouchedCount,
    stepsUsed: opts.stepsUsed,
    loopNudges: 0,
  };
}

/**
 * Count the changed lines in a unified diff: every `+` and every `-` line,
 * excluding the `+++`/`---` file headers and the unchanged context lines.
 *
 * The two directions are SUMMED, not netted — a diff that swaps 40 lines for 40
 * other lines is 80 changed lines of review surface, not zero. That is the
 * quantity the diff budget is meant to bound.
 */
export function countDiffLines(diff: string): number {
  let added = 0;
  let removed = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }

  return added + removed;
}

/**
 * Whether deterministic judge-skip is enabled. ADR-021 §1: skipping the frontier
 * completeness judge when executed signals already settle the outcome is the
 * DEFAULT — a model call the ladder/evidence can replace is a defect, not a
 * feature to opt into. So this returns `true` unless `OXAGEN_LADDER` is set to an
 * explicit falsey value (`0`/`false`/`off`/`no`), which opts OUT and forces the
 * judge to run every round. Legacy `OXAGEN_LADDER=1` still enables it (now the
 * default). Exported for tests.
 */
export function resolveJudgeSkipEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env["OXAGEN_LADDER"];
  if (raw === undefined) return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

/**
 * True when the judge can be skipped because the turn was read-only and changed
 * nothing. ADR-021 §1: a read-only turn can never trigger a revise (the pipeline
 * gates revision on `!readOnly`), and there is no diff to verify, so running a
 * frontier completeness judge on it is pure waste. Exported for tests.
 */
export function shouldSkipJudgeReadOnly(opts: {
  readOnly: boolean;
  diff: string;
}): boolean {
  return opts.readOnly && countDiffLines(opts.diff) === 0;
}

/**
 * Decide the next ladder rung and determine whether to skip the judge.
 *
 * When judge-skip is enabled (the default — see {@link resolveJudgeSkipEnabled}),
 * calls the decision engine with measured signals and returns the decision.
 *
 * 'submit-fast' action means: skip the judge this round, treat the turn as complete
 * (oracle flipped + touched tests green + diff within budget — executed evidence
 * already proves completion). Other actions mean: run the existing judge logic.
 *
 * When judge-skip is disabled, returns undefined and the caller runs the standard
 * judge path.
 */
export function decideLadderPath(opts: {
  signals: LadderSignals;
  currentRung: 0 | 1 | 2 | 3;
  ladderEnabled: boolean;
}): LadderDecision | undefined {
  if (!opts.ladderEnabled) {
    return undefined;
  }

  const config = resolveLadderConfig(process.env);
  // Cap current rung to the max allowed.
  const cappedRung = Math.min(opts.currentRung, config.maxRung) as
    | 0
    | 1
    | 2
    | 3;
  return decide(opts.signals, config, cappedRung);
}
