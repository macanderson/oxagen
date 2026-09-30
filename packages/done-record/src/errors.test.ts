// errors.test.ts: DoneRecordError carries a stable code a caller can branch on.
import { describe, expect, it } from "vitest";
import { DONE_RECORD_ERROR_CODES, DoneRecordError } from "./errors";

describe("DoneRecordError", () => {
  it("carries its code, its name, and the message", () => {
    const error = new DoneRecordError("not_locked", "Lock the record first.");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_locked");
    expect(error.name).toBe("DoneRecordError");
    expect(error.message).toBe("Lock the record first.");
  });

  it("lists every code once", () => {
    expect(new Set(DONE_RECORD_ERROR_CODES).size).toBe(DONE_RECORD_ERROR_CODES.length);
    expect(DONE_RECORD_ERROR_CODES).toContain("drafting_conflict");
  });
});
