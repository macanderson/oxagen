// errors.ts: the one error the Phase 1 work records throw, and its codes.
//
// Every refusal names what went wrong and what to do next, so a handler can
// pass the message to a person unchanged. The codes let a caller tell a stale
// read apart from a forbidden action without parsing the message.

/** Why a work record refused a write. */
export const WORK_RECORD_ERROR_CODES = [
  /** The input does not have the shape the record needs. */
  "invalid_input",
  /** The item changed since the caller read it: the version does not match. */
  "stale_version",
  /** The caller acted on an item revision that is no longer current. */
  "stale_revision",
  /** The caller named a brief revision or digest that is no longer current. */
  "stale_brief",
  /** The caller named a head commit that is no longer the pull request's head. */
  "stale_head",
  /** The item's state does not allow the action. */
  "not_allowed",
  /** A key or a capacity slot is already held by another record. */
  "conflict",
  /** The actor may not take the action. */
  "forbidden",
  /** The record the caller named does not exist in this workspace. */
  "not_found",
] as const;
export type WorkRecordErrorCode = (typeof WORK_RECORD_ERROR_CODES)[number];

/** A refused write to a work record. */
export class WorkRecordError extends Error {
  readonly code: WorkRecordErrorCode;

  constructor(code: WorkRecordErrorCode, message: string) {
    super(message);
    this.name = "WorkRecordError";
    this.code = code;
  }
}

/** True when the value is a WorkRecordError, with an optional code to match. */
export function isWorkRecordError(value: unknown, code?: WorkRecordErrorCode): value is WorkRecordError {
  return value instanceof WorkRecordError && (code === undefined || value.code === code);
}
