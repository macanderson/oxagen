import { describe, expect, it } from "vitest";
import { isCursorInstant } from "./cursor-instant";

describe("isCursorInstant", () => {
  it("admits the instant toISOString writes", () => {
    expect(
      isCursorInstant(new Date("2026-09-25T09:30:00Z").toISOString()),
    ).toBe(true);
  });

  // Each of these passes Date.parse and fails Postgres's timestamptz cast, so
  // a cursor carrying one came back as a 500 (#4370 review, rounds 1 and 2).
  it("refuses signed, expanded and zero years (negative)", () => {
    for (const at of [
      "-000001-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
    ]) {
      expect(isCursorInstant(at)).toBe(false);
    }
  });

  it("refuses other spellings of a real instant (negative)", () => {
    for (const at of [
      "2026-09-25 09:30:00+00",
      "2026-09-25T09:30:00Z",
      "2026-09-25",
      "yesterday",
    ]) {
      expect(isCursorInstant(at)).toBe(false);
    }
  });
});
