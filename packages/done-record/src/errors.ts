// errors.ts: the one error this package throws, with a stable code a caller
// can branch on.

/** Why a lock, a conversion, or a claim was refused. */
export const DONE_RECORD_ERROR_CODES = [
  "lint_failed",
  "invalid_input",
  "not_locked",
  "unknown_criterion",
  "already_claimed",
  "drafting_conflict",
] as const;
export type DoneRecordErrorCode = (typeof DONE_RECORD_ERROR_CODES)[number];

/** A done record operation that was refused. The message says what to fix. */
export class DoneRecordError extends Error {
  readonly code: DoneRecordErrorCode;

  constructor(code: DoneRecordErrorCode, message: string) {
    super(message);
    this.name = "DoneRecordError";
    this.code = code;
  }
}
