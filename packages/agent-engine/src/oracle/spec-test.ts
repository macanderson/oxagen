/**
 * Spec-test oracle tracker for F2 (spec-first oracle).
 *
 * Watches tool traffic for a repro signal — a bash command that matches
 * test-like patterns with failing exit → later passing exit on the same
 * normalized command. Exposes oracle state: 'none' (no failing test seen),
 * 'failing' (test-like command failed), or 'flipped' (previously-failing
 * command now passes).
 *
 * Pure TypeScript, no external deps, no I/O.
 */

// ── Test command detection ──────────────────────────────

// Whether a command runs tests is a parse of its argv-0, not a scan of the
// line: see ./command-runs-tests.ts for why, and for what it admits. It is
// re-exported here because this module's public surface is what callers have
// always imported.
export { isTestLikeCommand } from "./command-runs-tests";
import { isTestLikeCommand } from "./command-runs-tests";

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a command for comparison: trim and collapse internal whitespace
 * runs to single spaces.
 */
function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

// ── State machine ──────────────────────────────────────────────────────────────

export type OracleState = "none" | "failing" | "flipped";

export interface ObservedCommand {
  command: string;
  exitCode: number;
}

/**
 * Tracks the state of a spec-test oracle based on observed test commands.
 *
 * State semantics:
 * - 'none': no test-like command with non-zero exit has been observed.
 * - 'failing': a test-like command with exitCode !== 0 has been observed.
 * - 'flipped': a test-like command that previously had exitCode !== 0 later
 *   observes exitCode === 0 (fail → ... → pass on the SAME normalized command).
 *
 * Once 'flipped', state stays 'flipped' even if other commands fail afterwards.
 * A command that only ever passes never advances state.
 * Intervening failures of other commands do not prevent a flip.
 */
export interface SpecTestTracker {
  /**
   * Observe a command execution. If the command is not test-like, it is ignored.
   * Normalized command is compared; whitespace variants are treated identically.
   */
  observe(cmd: ObservedCommand): void;

  /**
   * Current oracle state: 'none', 'failing', or 'flipped'.
   */
  state(): OracleState;

  /**
   * Returns the normalized command that caused the flip, or null if not yet flipped.
   */
  flippedBy(): string | null;

  /**
   * Returns distinct normalized test-like commands seen, in insertion order.
   */
  testCommands(): string[];

  /**
   * Returns a map of each normalized test command to its most recent exit code.
   * Used to check if all touched-file tests are currently passing.
   */
  lastOutcomes(): Map<string, number>;
}

/**
 * Factory: creates a new SpecTestTracker.
 */
export function createSpecTestTracker(): SpecTestTracker {
  let currentState: OracleState = "none";
  let flippedCommand: string | null = null;

  // Map from normalized command → latest observed exitCode.
  const commandExitCodes = new Map<string, number>();

  // Ordered list of distinct normalized test commands seen.
  const seenTestCommands: string[] = [];

  return {
    observe(cmd: ObservedCommand): void {
      // Normalize before the test-like check so whitespace variants of the
      // same command are recognized (and compared) identically.
      const normalized = normalizeCommand(cmd.command);
      if (!isTestLikeCommand(normalized)) {
        return;
      }

      // Track distinct test commands in insertion order.
      if (!seenTestCommands.includes(normalized)) {
        seenTestCommands.push(normalized);
      }

      const previousExitCode = commandExitCodes.get(normalized);
      commandExitCodes.set(normalized, cmd.exitCode);

      // State transitions.
      if (currentState === "flipped") {
        // Once flipped, stay flipped.
        return;
      }

      if (cmd.exitCode !== 0) {
        // Failing command observed.
        if (currentState === "none") {
          currentState = "failing";
        }
      } else if (cmd.exitCode === 0) {
        // Passing command observed.
        if (
          currentState === "failing" &&
          previousExitCode !== 0 &&
          previousExitCode !== undefined
        ) {
          // This command previously failed and now passes → flip!
          currentState = "flipped";
          flippedCommand = normalized;
        }
      }
    },

    state(): OracleState {
      return currentState;
    },

    flippedBy(): string | null {
      return flippedCommand;
    },

    testCommands(): string[] {
      return [...seenTestCommands];
    },

    lastOutcomes(): Map<string, number> {
      return new Map(commandExitCodes);
    },
  };
}
