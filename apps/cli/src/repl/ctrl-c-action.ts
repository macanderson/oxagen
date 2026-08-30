/**
 * ctrl-c-action.ts — the pure decision for what a Ctrl-C press should do.
 *
 * Extracted from interactive.tsx's key handler so the double-press-to-exit
 * state machine is unit-testable without mounting the whole REPL. Priority
 * (highest first), matching a real shell:
 *
 *   1. A live `!command` child is running → kill it.
 *   2. A turn is streaming             → cancel the turn.
 *   3. Idle with text in the prompt    → clear the input (Claude Code behavior),
 *                                          never exit.
 *   4. Idle with an empty prompt       → require a DOUBLE press: the first arms
 *                                          (show a hint), a second within
 *                                          CTRL_C_EXIT_WINDOW_MS exits.
 *
 * The non-negotiable this encodes: a single idle Ctrl-C must never exit and
 * never destroy typed-but-unsent input.
 */

/** Window (ms) a second idle Ctrl-C must land within to actually exit. */
export const CTRL_C_EXIT_WINDOW_MS = 1500;

export type CtrlCAction =
  | "kill-terminal"
  | "cancel-turn"
  | "clear-input"
  | "arm-exit"
  | "exit";

export interface CtrlCContext {
  /** A `!command` child process is currently running. */
  terminalRunning: boolean;
  /** A model turn is streaming (and abortable). */
  streaming: boolean;
  /** The prompt bar buffer is empty. */
  inputEmpty: boolean;
  /** Timestamp (ms) of the previous arming Ctrl-C, or null if not armed. */
  lastCtrlCMs: number | null;
}

export function resolveCtrlC(ctx: CtrlCContext, now: number): CtrlCAction {
  if (ctx.terminalRunning) return "kill-terminal";
  if (ctx.streaming) return "cancel-turn";
  // Idle from here down.
  if (!ctx.inputEmpty) return "clear-input";
  if (
    ctx.lastCtrlCMs !== null &&
    now - ctx.lastCtrlCMs <= CTRL_C_EXIT_WINDOW_MS
  ) {
    return "exit";
  }
  return "arm-exit";
}
