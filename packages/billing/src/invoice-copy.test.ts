/** Unit tests for invoice-copy.ts: the words and figures on an invoice line. */
import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatMoney,
  formatPeriod,
  formatRatePerThousand,
  providerPeriodSeconds,
} from "./invoice-copy";

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("formatMoney", () => {
  it.each([
    [12_000_000, "usd", "$120,000.00"],
    [500_000n, "usd", "$5,000.00"],
    [5, "usd", "$0.05"],
    [1_500, "eur", "€15.00"],
    // A zero-decimal currency: minor units are whole yen.
    [1_500, "jpy", "¥1,500"],
  ])("prints %s %s as %s", (minor, currency, expected) => {
    expect(formatMoney(minor, currency)).toBe(expected);
  });
});

describe("formatRatePerThousand", () => {
  it.each([
    [3_000n, "$3.00 per 1,000"],
    [5_000n, "$5.00 per 1,000"],
    [12_345n, "$12.345 per 1,000"],
    [100n, "$0.10 per 1,000"],
  ])("prints %s micros a unit as %s", (rate, expected) => {
    expect(formatRatePerThousand(rate, "usd")).toBe(expected);
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(2_000_000)).toBe("2,000,000");
    expect(formatCount(7n)).toBe("7");
  });
});

describe("formatPeriod", () => {
  it("prints a half-open period by its last day", () => {
    expect(
      formatPeriod({ start: utc("2026-09-01"), end: utc("2026-10-01") }),
    ).toBe("1 Sep to 30 Sep 2026");
  });

  it("names both years when the period crosses one", () => {
    expect(
      formatPeriod({ start: utc("2026-10-01"), end: utc("2027-10-01") }),
    ).toBe("1 Oct 2026 to 30 Sep 2027");
  });

  it("prints one day once", () => {
    expect(
      formatPeriod({ start: utc("2026-09-01"), end: utc("2026-09-02") }),
    ).toBe("1 Sep 2026");
  });

  it("reads the calendar in UTC, whatever the anchor's time of day", () => {
    expect(
      formatPeriod({
        start: new Date("2026-01-31T15:00:00.000Z"),
        end: new Date("2026-02-28T15:00:00.000Z"),
      }),
    ).toBe("31 Jan to 28 Feb 2026");
  });
});

describe("providerPeriodSeconds", () => {
  it("ends on the last second inside the period", () => {
    expect(
      providerPeriodSeconds({
        start: utc("2026-09-01"),
        end: utc("2026-10-01"),
      }),
    ).toEqual({
      start: Date.UTC(2026, 8, 1) / 1000,
      end: Date.UTC(2026, 9, 1) / 1000 - 1,
    });
  });

  it("never ends before it starts", () => {
    const at = new Date("2026-09-01T00:00:00.400Z");
    const { start, end } = providerPeriodSeconds({ start: at, end: at });
    expect(end).toBe(start);
  });
});
