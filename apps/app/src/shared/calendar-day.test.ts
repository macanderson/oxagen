import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { describe, expect, it } from "vitest";
import {
  endOfZonedDay,
  isCalendarDay,
  startOfNextZonedDay,
  startOfZonedDay,
  supportsTimeZone,
} from "./calendar-day";

describe("startOfZonedDay", () => {
  it("maps a Los Angeles day to the UTC instant that day begins there", () => {
    // 2026-01-15 00:00 America/Los_Angeles is 2026-01-15 08:00 UTC (PST, UTC-8).
    expect(startOfZonedDay("2026-01-15", "America/Los_Angeles")).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("maps a Tokyo day to the UTC instant that day begins there", () => {
    // 2026-01-15 00:00 Asia/Tokyo is 2026-01-14 15:00 UTC (UTC+9).
    expect(startOfZonedDay("2026-01-15", "Asia/Tokyo")).toBe(
      "2026-01-14T15:00:00.000Z",
    );
  });

  it("defaults to Pacific time", () => {
    expect(startOfZonedDay("2026-01-15")).toBe(
      startOfZonedDay("2026-01-15", DEFAULT_TIME_ZONE),
    );
  });

  it("refuses a non-day (negative)", () => {
    expect(startOfZonedDay("2026-1-15", "UTC")).toBeNull();
  });
});

describe("endOfZonedDay", () => {
  it("keeps a Los Angeles day inclusive through its last millisecond", () => {
    expect(endOfZonedDay("2026-01-15", "America/Los_Angeles")).toBe(
      "2026-01-16T07:59:59.999Z",
    );
  });
});

describe("startOfNextZonedDay", () => {
  it("is exclusive of the named Los Angeles day", () => {
    expect(startOfNextZonedDay("2026-01-15", "America/Los_Angeles")).toBe(
      "2026-01-16T08:00:00.000Z",
    );
  });

  it("crosses a month boundary on the civil calendar", () => {
    expect(startOfNextZonedDay("2026-01-31", "UTC")).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });
});

describe("civil days whose midnight a DST jump skips", () => {
  // Santiago starts DST on 2026-09-06 by going 00:00 -> 01:00, so that day has
  // no local midnight at all. Its first instant is 01:00 local, 04:00 UTC. The
  // wrong answer is 03:00 UTC, which reads as 23:00 on 2026-09-05 there.
  it("starts a Santiago day at the first instant the day reaches", () => {
    expect(startOfZonedDay("2026-09-06", "America/Santiago")).toBe(
      "2026-09-06T04:00:00.000Z",
    );
  });

  it("closes the Santiago day before at that same instant", () => {
    expect(startOfNextZonedDay("2026-09-05", "America/Santiago")).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    expect(endOfZonedDay("2026-09-05", "America/Santiago")).toBe(
      "2026-09-06T03:59:59.999Z",
    );
  });

  it("ends the skipped-midnight day at the next day's real midnight", () => {
    // 2026-09-07 00:00 in Santiago exists and is 03:00Z at the new UTC-3
    // offset, so the short day runs 04:00Z to 02:59:59.999Z the next day.
    expect(endOfZonedDay("2026-09-06", "America/Santiago")).toBe(
      "2026-09-07T02:59:59.999Z",
    );
  });

  // The Azores do the same on 2026-03-29, going 00:00 -> 01:00 from UTC-1 to
  // UTC+0, so the day's first instant is 01:00 local and 01:00 UTC.
  it("starts an Azores day at the first instant the day reaches", () => {
    expect(startOfZonedDay("2026-03-29", "Atlantic/Azores")).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    expect(endOfZonedDay("2026-03-28", "Atlantic/Azores")).toBe(
      "2026-03-29T00:59:59.999Z",
    );
  });

  it("resolves an ordinary spring-forward day to its real midnight", () => {
    // Los Angeles jumps at 02:00 on 2026-03-08, well clear of midnight, so
    // that day still starts at 00:00 local — 08:00 UTC at PST.
    expect(startOfZonedDay("2026-03-08", "America/Los_Angeles")).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    expect(endOfZonedDay("2026-03-08", "America/Los_Angeles")).toBe(
      "2026-03-09T06:59:59.999Z",
    );
  });

  it("resolves a fall-back day to the first of its two midnights", () => {
    // Havana rewinds 01:00 -> 00:00 on 2026-11-01, so that midnight happens
    // twice, at 04:00Z and again at 05:00Z. The day starts at the first.
    expect(startOfZonedDay("2026-11-01", "America/Havana")).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(endOfZonedDay("2026-10-31", "America/Havana")).toBe(
      "2026-11-01T03:59:59.999Z",
    );
  });
});

describe("supportsTimeZone", () => {
  it("knows the zones this runtime can format in, and the ones it cannot", () => {
    expect(supportsTimeZone("America/Los_Angeles")).toBe(true);
    expect(supportsTimeZone("UTC")).toBe(true);
    expect(supportsTimeZone(DEFAULT_TIME_ZONE)).toBe(true);
    expect(supportsTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(supportsTimeZone("")).toBe(false);
  });

  it("answers no day at all for a zone nothing can be formatted in (negative)", () => {
    // The stored zone is free text and the contract admits any zone-shaped
    // name, so an unknown one reaches the resolvers. It reads as no answer,
    // never as a thrown RangeError out of a date conversion.
    expect(startOfZonedDay("2026-09-18", "Mars/Olympus_Mons")).toBeNull();
    expect(startOfNextZonedDay("2026-09-18", "Mars/Olympus_Mons")).toBeNull();
    expect(endOfZonedDay("2026-09-18", "Mars/Olympus_Mons")).toBeNull();
  });
});

// A day's SHAPE is not a day. This guards a mandate's validity end, where the
// gap was worth three days of authority: `2027-02-31` matches the pattern and
// `Date.UTC` rolls it to 3 March without complaint, so a caller that sent a date
// which does not exist got a longer window than any date could have named.
describe("isCalendarDay", () => {
  it("takes a day that exists, including a leap day that does", () => {
    for (const day of ["2027-01-01", "2027-02-28", "2028-02-29", "2027-12-31"])
      expect(isCalendarDay(day)).toBe(true);
  });

  it("refuses a day that rolls forward rather than failing (negative)", () => {
    // Each of these is accepted by a shape check and silently becomes another
    // date. 2027 is not a leap year, so the 29th is in this set too.
    for (const day of ["2027-02-29", "2027-02-31", "2027-04-31", "2027-06-31"])
      expect(isCalendarDay(day)).toBe(false);
  });

  it("refuses a month or day outside the calendar (negative)", () => {
    for (const day of ["2026-99-99", "2027-13-01", "2027-00-10", "2027-01-00"])
      expect(isCalendarDay(day)).toBe(false);
  });

  it("refuses anything that is not a padded day (negative)", () => {
    for (const day of [
      "",
      "not a day",
      "2027-1-1",
      "2027-01",
      "2027-01-01T00:00:00Z",
    ])
      expect(isCalendarDay(day)).toBe(false);
  });
});
