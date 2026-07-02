/**
 * Pure, unit-testable helper for "press a key twice to confirm" chords.
 *
 * The Task Progress panel arms a destructive/edit action on the first press and
 * fires it on the second press within a short window — `Ctrl-X Ctrl-X` deletes
 * the selected task, `Ctrl-E Ctrl-E` edits it. This mirrors the double-Esc reset
 * flow but is generic over the key, so the panel keeps no bespoke timing logic.
 *
 * Usage: keep the timestamp of the last press for each chord in a ref. On every
 * press call {@link resolveDoublePress} with that timestamp and `Date.now()`; it
 * tells you whether this press ARMED the chord (first press — show a hint) or
 * FIRED it (second press within the window — do the thing). The caller updates
 * the stored timestamp to the returned `nextLastPressMs`.
 */

/** Two presses within this window (ms) count as a confirmed double-press. */
export const DOUBLE_PRESS_WINDOW_MS = 1000;

export type DoublePressResult = {
  /** 'armed' — first press; caller should show a "press again to confirm" hint.
   *  'fired' — second press within the window; caller should perform the action. */
  action: "armed" | "fired";
  /** The timestamp the caller should store for the next press. On 'fired' this is
   *  null so a third press starts a fresh pair (never fires twice off one arm). */
  nextLastPressMs: number | null;
};

/**
 * Decide whether this key press arms or fires a double-press chord.
 *
 * @param lastPressMs Timestamp (ms) of the previous press of this chord, or null.
 * @param nowMs       Current timestamp (ms); injectable for tests.
 * @param windowMs    Confirm window; defaults to {@link DOUBLE_PRESS_WINDOW_MS}.
 */
export function resolveDoublePress(
  lastPressMs: number | null,
  nowMs: number,
  windowMs: number = DOUBLE_PRESS_WINDOW_MS,
): DoublePressResult {
  const elapsed = lastPressMs !== null ? nowMs - lastPressMs : Infinity;
  if (elapsed <= windowMs) {
    // Second press inside the window → fire, and clear so the next press re-arms.
    return { action: "fired", nextLastPressMs: null };
  }
  // First press (or too slow after a previous one) → arm and record this press.
  return { action: "armed", nextLastPressMs: nowMs };
}
