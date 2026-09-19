import { describe, expect, it } from "vitest";
import { endOfLocalDay, isUsableOffset, offsetAfter } from "./validity";

// The boundary of a bounded financial authority, so it gets its own tests rather
// than only riding the write's. Pure by design: no browser, and no dependence on
// the runner's TZ, which is what made the old behaviour hard to see. Every instant
// asserted here was checked against V8's own Date before it was written down.
describe("endOfLocalDay", () => {
  it("ends the window as the next day begins, because the window is half-open", () => {
    // `[validFrom, validTo)`, so the last day is covered by ending at the start
    // of the day after it. The old `T23:59:59.999Z` left that day's final
    // millisecond unauthorised while reading as though it did not.
    expect(endOfLocalDay("2027-03-31", 0)).toBe("2027-04-01T00:00:00.000Z");
  });

  it("takes the day from the operator, not from UTC", () => {
    // The defect this replaced. At UTC+9 the operator's 31 December ends at
    // 15:00Z; writing 23:59:59.999Z granted nine further hours nobody asked for.
    expect(endOfLocalDay("2026-12-31", -540)).toBe("2026-12-31T15:00:00.000Z");
    // And at UTC-8 it ends after the UTC day, so the old value cut it short.
    expect(endOfLocalDay("2026-12-31", 480)).toBe("2027-01-01T08:00:00.000Z");
  });

  it("rolls a month, a year and a leap day over without a special case", () => {
    expect(endOfLocalDay("2027-01-31", 0)).toBe("2027-02-01T00:00:00.000Z");
    expect(endOfLocalDay("2027-12-31", 0)).toBe("2028-01-01T00:00:00.000Z");
    expect(endOfLocalDay("2028-02-28", 0)).toBe("2028-02-29T00:00:00.000Z");
    expect(endOfLocalDay("2028-02-29", 0)).toBe("2028-03-01T00:00:00.000Z");
  });

  it("uses the offset it is given, which is the one in force after the last day", () => {
    // The caller reads the offset for the day after `day`, so a window ending
    // the day before a DST change and one ending the day after it differ by the
    // hour they should. Proving the arithmetic honours the offset is this
    // function's half of that; taking the right offset is the dialog's.
    expect(endOfLocalDay("2027-03-13", 300)).toBe("2027-03-14T05:00:00.000Z");
    expect(endOfLocalDay("2027-03-14", 240)).toBe("2027-03-15T04:00:00.000Z");
  });
});

describe("isUsableOffset", () => {
  it("takes the offsets real places are in, to the whole minute", () => {
    // The real extremes, and the quarter- and half-hour zones that are easy to
    // forget exist: Kathmandu is +5:45 and Chatham is +12:45.
    for (const ok of [0, -540, 480, -345, -765, 840, -720])
      expect(isUsableOffset(ok)).toBe(true);
  });

  it("refuses what no place is in, and what is not a whole minute (negative)", () => {
    for (const bad of [841, -841, 1440, 90.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isUsableOffset(bad)).toBe(false);
  });
});

describe("offsetAfter", () => {
  // Asserted as a relation rather than a number, so this passes under any TZ the
  // runner happens to have: what matters is that it reads the offset for the day
  // AFTER the one given, which is the instant the window ends.
  it("reads the offset of the day after the last day", () => {
    expect(offsetAfter("2027-06-30")).toBe(
      new Date(2027, 5, 31).getTimezoneOffset(),
    );
    // Across a month end, so the roll-over is the Date constructor's and not ours.
    expect(offsetAfter("2027-01-31")).toBe(
      new Date(2027, 0, 32).getTimezoneOffset(),
    );
  });

  it("answers zero for a day it cannot read, rather than NaN", () => {
    // NaN would reach the action and be refused there, but a number that poisons
    // the arithmetic is worse than one the validator can judge.
    for (const junk of ["", "next year", "2027-06", "----"])
      expect(offsetAfter(junk)).toBe(0);
  });
});
