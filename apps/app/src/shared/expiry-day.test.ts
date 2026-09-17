// The day an expiry picker names, as the instant that is stored for it.
import { describe, expect, it } from "vitest";
import { endOfUtcDay } from "./expiry-day";

describe("endOfUtcDay", () => {
  it("is the last instant of the day in UTC, not midnight at its start", () => {
    expect(endOfUtcDay("2027-03-01")).toBe("2027-03-01T23:59:59.999Z");
  });

  it("keeps the day the picker named, whatever the viewer's calendar shows", () => {
    // The control hands over a bare YYYY-MM-DD; the day is read as a UTC day
    // and the field says so, so nothing is silently shifted.
    expect(endOfUtcDay("2027-12-31")).toBe("2027-12-31T23:59:59.999Z");
    expect(endOfUtcDay("2028-02-29")).toBe("2028-02-29T23:59:59.999Z");
  });

  it.each([
    ["next tuesday", "not a date at all"],
    ["2027-13-01", "a month the calendar has not"],
    ["2027-02-31", "a day the month has not"],
    ["01/03/2027", "a day written another way"],
    ["2027-03-01T00:00:00Z", "an instant rather than a day"],
    ["", "an empty field"],
  ])("refuses %o, %s (negative)", (value) => {
    expect(endOfUtcDay(value)).toBeNull();
  });

  it("refuses a day the calendar rolls forward rather than storing the rolled day (negative)", () => {
    // new Date("2027-02-31T…") is March 3rd; the round trip is what catches it.
    expect(endOfUtcDay("2027-02-31")).toBeNull();
    expect(endOfUtcDay("2027-04-31")).toBeNull();
  });
});
