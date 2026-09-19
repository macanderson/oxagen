import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { describe, expect, it } from "vitest";
import {
  endOfZonedDay,
  startOfNextZonedDay,
  startOfZonedDay,
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
