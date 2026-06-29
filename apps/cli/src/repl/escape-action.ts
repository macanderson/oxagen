/**
 * Pure, unit-testable helper for the REPL's Escape-key state machine.
 *
 * Given a snapshot of the current REPL state and the timestamp of the Esc
 * press, returns the action that should be taken.
 *
 *   'stop'         — interrupt the in-flight agent turn (Esc while streaming)
 *   'prompt-reset' — second consecutive Esc within DOUBLE_ESC_WINDOW_MS →
 *                    show the "reset conversation?" confirmation prompt
 *   'none'         — no-op (first idle Esc, outside the window, or while a
 *                    reset confirmation is already showing)
 *
 * The caller is responsible for:
 *   1. Updating lastEscapeMs after each Esc press (so the window tracking
 *      works across successive calls).
 *   2. Handling the "Esc cancels an already-showing confirmation" case in the
 *      UI layer (before calling this function), since that is an explicit
 *      UI-layer concern rather than a state-machine decision.
 */

export type EscapeState = {
  /** True while the agent turn is in flight (streaming / awaiting a tool). */
  isStreaming: boolean;
  /**
   * True while the reset-confirmation prompt is already visible.
   * When true this function always returns 'none' so the confirmation is not
   * re-triggered.
   */
  resetPending: boolean;
  /**
   * Timestamp (ms) of the previous Esc press, or null if there was none (or
   * if the window has been intentionally cleared, e.g. after a 'prompt-reset'
   * fires).
   */
  lastEscapeMs: number | null;
};

export type EscapeAction = "stop" | "prompt-reset" | "none";

/** Two Esc presses within this window trigger the reset-confirm flow. */
export const DOUBLE_ESC_WINDOW_MS = 1500;

/**
 * Decide what action to take when the user presses Escape.
 *
 * @param state   Snapshot of the relevant REPL state at the moment of the press.
 * @param nowMs   Current timestamp in milliseconds (injectable for tests).
 * @returns       The action the REPL should execute.
 */
export function resolveEscapeAction(
  state: EscapeState,
  nowMs: number,
): EscapeAction {
  // While a reset confirmation is already visible, additional Esc presses are
  // silently ignored — the caller should handle "Esc cancels confirmation"
  // separately, before calling this function.
  if (state.resetPending) return "none";

  // First Esc while streaming interrupts the running agent turn.
  if (state.isStreaming) return "stop";

  // Not streaming: decide whether this is the second of a double-Esc sequence.
  const elapsed =
    state.lastEscapeMs !== null ? nowMs - state.lastEscapeMs : Infinity;

  if (elapsed <= DOUBLE_ESC_WINDOW_MS) {
    return "prompt-reset";
  }

  // First (or too-slow) Esc while idle — no visible action, but the caller
  // must record this timestamp as lastEscapeMs for the next press.
  return "none";
}
