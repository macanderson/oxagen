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

// ═══════════════════════════════════════════════════════════════════════════
// V2 — terminal selection for a fenced attempt
// ═══════════════════════════════════════════════════════════════════════════
//
// Same precedence rule, one different consequence: V1's "none" meant *skip the
// terminal write*, while V2's means *make no store mutation whatsoever*. A
// fenced attempt is not merely racing for a status column; the events and seal
// it would write belong to an attempt that already owns this run's evidence.

/** Reason recorded when the cancel poller, not the driver, ended the attempt. */
export const CANCEL_REASON_CODE = "cancel_requested";
/** Reason recorded when the driver threw. */
export const DRIVER_ERROR_REASON_CODE = "driver_error";

/** Terminal statuses a WORKER may seal. `abandoned` belongs to the reclaimer. */
export type WorkerSealStatus = "completed" | "denied" | "failed" | "cancelled";

export type AttemptTerminalDecision =
  | { kind: "none" }
  | {
      kind: "seal";
      status: WorkerSealStatus;
      reasonCode?: string;
      /** Recorded on the run row, never on the event — a message can carry raw content. */
      error?: string;
      result?: unknown;
    };

export interface AttemptTerminalInput {
  /** A renew/append/cancel-check reported a fence: another attempt owns the run. */
  fenced: boolean;
  /** `isAttemptCancelRequested` returned true at some point. */
  cancelled: boolean;
  driverError: { error: unknown } | null;
  /** The driver's deliberate settle, or null when it threw. */
  outcome: {
    result: unknown;
    terminalStatus?: "completed" | "denied";
    reasonCode?: string;
  } | null;
}

export function decideAttemptTerminalAction(
  input: AttemptTerminalInput,
): AttemptTerminalDecision {
  if (input.fenced) return { kind: "none" };
  if (input.cancelled) {
    return {
      kind: "seal",
      status: "cancelled",
      reasonCode: CANCEL_REASON_CODE,
    };
  }
  if (input.driverError !== null) {
    return {
      kind: "seal",
      status: "failed",
      reasonCode: DRIVER_ERROR_REASON_CODE,
      error: errorMessage(input.driverError.error),
    };
  }
  // A denial is a DECIDED outcome, not a crash: the driver settled normally
  // and told us authorization refused it, so the attempt seals as `denied`
  // (which `runStatusForTerminal` still drives the run to `failed`) with the
  // denial itself preserved as evidence on the sealed attempt.
  return {
    kind: "seal",
    status: input.outcome?.terminalStatus ?? "completed",
    reasonCode: input.outcome?.reasonCode,
    result: input.outcome?.result,
  };
}
