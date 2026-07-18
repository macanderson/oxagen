/**
 * Terminal-state selection for a driven run — pure, table-driven
 * (docs/specs/agent-engine-v2 Phase 2c). Centralizing the decision keeps the
 * precedence rule testable without a store or driver: lease loss always wins
 * (the other claimant owns the row now — the worker must not touch the store
 * again for it, regardless of how the driver's promise settled), a cancel
 * request beats a driver throw (an aborted driver commonly throws an
 * AbortError, but the *reason* for the abort is what the store needs to hear),
 * and only then does a driver throw vs. a clean return decide fail vs. complete.
 */

export type TerminalDecision =
  | { kind: "none" }
  | { kind: "cancel" }
  | { kind: "fail"; message: string }
  | { kind: "complete"; result: unknown };

export interface TerminalInput {
  /** `renewLease`/`saveCheckpoint` returned false: another worker owns this run now. */
  leaseLost: boolean;
  /** `isCancelRequested` returned true at some point during the run. */
  cancelled: boolean;
  /**
   * Wrapped so "the driver threw `null`/`undefined`" is still distinguishable
   * from "the driver did not throw" — `null` means no error, never ambiguous.
   */
  driverError: { error: unknown } | null;
  /** The driver's resolved `{ result }.result`, when it didn't throw. */
  result: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function decideTerminalAction(input: TerminalInput): TerminalDecision {
  if (input.leaseLost) return { kind: "none" };
  if (input.cancelled) return { kind: "cancel" };
  if (input.driverError !== null) {
    return { kind: "fail", message: errorMessage(input.driverError.error) };
  }
  return { kind: "complete", result: input.result };
}
