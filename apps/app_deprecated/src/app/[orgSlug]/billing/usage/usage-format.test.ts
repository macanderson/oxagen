import { describe, it, expect } from "vitest";
import {
  parseRange,
  rangeToWindow,
  rangeLabel,
  formatTokens,
  formatUsdFromMicros,
  formatDayShort,
  DEFAULT_RANGE,
} from "./usage-format";

describe("parseRange", () => {
  it("returns a known preset unchanged", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("mtd")).toBe("mtd");
  });
  it("falls back to the default for unknown or missing values", () => {
    expect(parseRange(undefined)).toBe(DEFAULT_RANGE);
    expect(parseRange("garbage")).toBe(DEFAULT_RANGE);
    expect(parseRange("1y")).toBe(DEFAULT_RANGE);
  });
});

describe("rangeToWindow", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("computes a rolling N-day window ending at now", () => {
    const { start, end } = rangeToWindow("7d", now);
    expect(end).toEqual(now);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("computes 30 and 90 day windows", () => {
    expect(
      rangeToWindow("30d", now).end.getTime() -
        rangeToWindow("30d", now).start.getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);
    expect(
      rangeToWindow("90d", now).end.getTime() -
        rangeToWindow("90d", now).start.getTime(),
    ).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("month-to-date starts at the first of the (UTC) month", () => {
    const { start } = rangeToWindow("mtd", now);
    expect(start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("rangeLabel", () => {
  it("maps preset keys to labels", () => {
    expect(rangeLabel("7d")).toBe("7 days");
    expect(rangeLabel("mtd")).toBe("Month to date");
  });
});

describe("formatTokens", () => {
  it("formats millions, thousands, and small counts", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_500)).toBe("12.5K");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatUsdFromMicros", () => {
  it("converts micro-USD to a dollar string", () => {
    expect(formatUsdFromMicros(1_000_000)).toBe("$1.00");
    expect(formatUsdFromMicros(4_500_000)).toBe("$4.50");
    expect(formatUsdFromMicros(0)).toBe("$0.00");
  });
});

describe("formatDayShort", () => {
  it("renders a YYYY-MM-DD key as a short month/day label", () => {
    expect(formatDayShort("2026-06-01")).toBe("Jun 1");
  });
  it("passes malformed input through unchanged", () => {
    expect(formatDayShort("not-a-date")).toBe("not-a-date");
  });
});
