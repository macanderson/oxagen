// ledger-idle-close.ts — the control plane's close of a ledger attempt whose
// producer stopped reporting (#3988, ADR-180).
//
// The scan (`listIdleLedgerAttempts`, @oxagen/run-ledger) finds an open
// attempt with no event and no operator resume for twelve hours. It never
// lists a run an operator paused. This seals it through the ledger's
// own `sealAttempt`, so the seal, its archive segment, its grade and its
// finalization grant are the ones any producer's seal would write:
//
// - `terminalStatus: "abandoned"`, which records the `unobserved_tail` gap
//   and grades the recording `inspect`. The run turns `failed`, the status an
//   abandoned attempt has always given its run.
// - `reasonCode: "idle_timeout"`, so a reader can tell this close from a
//   producer's own abandoned seal.
// - `expectedAttemptSeq` set to the head the scan read. A producer that
//   appended since keeps its attempt open, and the close writes nothing.
//
// Unlike the wrapped-session close (ADR-159), this one is final. A seal mints
// the attempt's finalization grant and commits its stream digest, so a late
// append is refused as it is after any seal. ADR-180 records why.
import {
  isAttemptAdvancedError,
  LEDGER_IDLE_CLOSE_REASON,
  type IdleLedgerAttempt,
  type RunStore,
} from "@oxagen/run-ledger";
import { runInTenantScope } from "@oxagen/tenancy";

/** The sealer identity the idle close records on the seal row. */
export const LEDGER_IDLE_CLOSE_SEALER = "run.ledger-idle-close";

/** Recorded on `agent_runs.error`, which the run page shows for a failed run. */
export const LEDGER_IDLE_CLOSE_ERROR =
  "No event arrived for 12 hours, so Oxagen closed the attempt as abandoned.";

/** A run the close sealed, whose cost is now rolled up as final. */
export interface ClosedLedgerRun {
  runPublicId: string;
  orgId: string;
  workspaceId: string;
}

/**
 * Seal one idle attempt in its tenant's scope. Null when the attempt moved
 * since the scan: its producer appended (`AttemptAdvancedError`), or it sealed
 * the attempt itself, in which case `sealAttempt` returns that seal marked
 * `alreadySealed`. Any other failure throws, and the job leaves the attempt
 * for its next pass.
 */
export async function closeIdleLedgerAttempt(
  attempt: IdleLedgerAttempt,
  store: Pick<RunStore, "sealAttempt">,
): Promise<ClosedLedgerRun | null> {
  try {
    const handle = await runInTenantScope(
      { orgId: attempt.orgId, workspaceId: attempt.workspaceId },
      () =>
        store.sealAttempt({
          attemptId: attempt.attemptId,
          terminalStatus: "abandoned",
          reasonCode: LEDGER_IDLE_CLOSE_REASON,
          sealerId: LEDGER_IDLE_CLOSE_SEALER,
          error: LEDGER_IDLE_CLOSE_ERROR,
          expectedAttemptSeq: attempt.lastAttemptSeq,
        }),
    );
    if (handle.alreadySealed) return null;
    return {
      runPublicId: attempt.runPublicId,
      orgId: attempt.orgId,
      workspaceId: attempt.workspaceId,
    };
  } catch (err) {
    if (isAttemptAdvancedError(err)) return null;
    throw err;
  }
}
