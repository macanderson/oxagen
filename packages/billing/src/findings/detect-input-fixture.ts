/**
 * detect-input-fixture.ts — a detector test's input, with every read the
 * findings store sets present and empty. A test overrides the fields it
 * reads. The window is the 30 days before 2026-09-27, and every run falls
 * inside the frame read cap.
 */
import type { DetectReads } from "./shared";

/** The fixture window's end. */
export const FIXTURE_WINDOW_END = new Date("2026-09-27T00:00:00.000Z");
/** The fixture window's start, `FINDINGS_WINDOW_DAYS` before its end. */
export const FIXTURE_WINDOW_START = new Date("2026-08-28T00:00:00.000Z");

/**
 * A `DetectReads` with empty defaults. `frameCoverage` counts the runs given,
 * all read, unless the override sets it.
 */
export function detectInputFixture(
  over: Partial<DetectReads> = {},
): DetectReads {
  const runs = over.runs ?? [];
  return {
    window: { start: FIXTURE_WINDOW_START, end: FIXTURE_WINDOW_END },
    toolWindowStart: FIXTURE_WINDOW_START,
    runs,
    toolCalls: [],
    decidedSince: new Map(),
    frames: new Map(),
    firstPrompts: new Map(),
    fileChanges: new Map(),
    compactions: new Map(),
    outcomes: new Map(),
    frameCoverage: {
      runs: runs.length,
      read: runs.length,
      capped: 0,
      unmatched: 0,
    },
    ...over,
  };
}
