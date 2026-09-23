// @vitest-environment jsdom
// The Billing panel's date helpers (section.tsx): isoDate prints an instant's
// UTC calendar day, and usePeriod prints a billing period as its month when it
// is one whole UTC calendar month and as its two ISO days otherwise, so a
// period that straddles two months never reads as one of them.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/intl";
import { isoDate, usePeriod } from "./section";

const period = () =>
  renderHook(() => usePeriod(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <IntlProvider>{children}</IntlProvider>
    ),
  }).result.current;

describe("isoDate", () => {
  it("prints the UTC day, whatever offset the instant was written in", () => {
    expect(isoDate("2026-10-01T00:00:00.000Z")).toBe("2026-10-01");
    expect(isoDate("2026-09-30T20:00:00-04:00")).toBe("2026-10-01");
  });
});

describe("usePeriod", () => {
  it("prints one whole UTC month as the month", () => {
    expect(
      period()("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    ).toBe("September 2026");
  });

  it("prints December as a month, across the turn of the year", () => {
    expect(
      period()("2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"),
    ).toBe("December 2026");
  });

  it.each([
    [
      "starts mid-month",
      "2026-08-15T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
    ],
    [
      "starts after midnight",
      "2026-09-01T00:00:01.000Z",
      "2026-10-01T00:00:00.000Z",
    ],
    ["runs two months", "2026-09-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    [
      "ends short of the month",
      "2026-09-01T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    ],
  ])(
    "prints a period that %s as its two ISO days (negative)",
    (_case, start, end) => {
      expect(period()(start, end)).toBe(`${isoDate(start)} – ${isoDate(end)}`);
    },
  );
});
