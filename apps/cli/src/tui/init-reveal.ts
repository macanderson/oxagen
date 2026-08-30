/**
 * Pure column-by-column reveal sequencing for the OXAGEN wordmark (see
 * tui/banner.tsx's WORDMARK — reused as-is so the intro banner and the
 * `oxagen init` payoff draw the exact same letterforms).
 *
 * banner.tsx's own intro animation reveals row-by-row, top to bottom. This
 * reveals column-by-column, left to right, so it reads as the wordmark being
 * hand-drawn one stroke at a time — a deliberately different feel for a
 * deliberately different moment (a completion payoff, not a header).
 *
 * `revealFrame` is a pure function of a single integer (how many columns are
 * currently visible), so the render side (init-reveal-view.tsx) just needs
 * to advance that integer on a timer — see init-reveal.test.ts for the frame
 * sequencing this must satisfy.
 */
import { WORDMARK } from "./banner.js";

export const WORDMARK_WIDTH = Math.max(
  0,
  ...WORDMARK.map((line) => line.length),
);

/**
 * Every WORDMARK line, truncated to `revealedCols` characters and padded back
 * out to the full width with spaces — so the block never changes width or
 * height frame to frame, only which columns are "lit".
 */
export function revealFrame(revealedCols: number): string[] {
  const cols = Math.max(0, Math.min(revealedCols, WORDMARK_WIDTH));
  return WORDMARK.map((line) => line.slice(0, cols).padEnd(line.length, " "));
}

/** Whether `revealedCols` has uncovered the entire wordmark. */
export function isRevealComplete(revealedCols: number): boolean {
  return revealedCols >= WORDMARK_WIDTH;
}
