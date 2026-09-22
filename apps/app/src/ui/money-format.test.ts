// Money, counts and clock readings as text: exact micros at any magnitude,
// half-even cents, trimmed exact precision, a refusal for a display string, and
// ratios as percentages.
import { describe, expect, it } from "vitest";
import {
  formatByteSize,
  formatClock,
  formatCount,
  formatDuration,
  formatMoney,
  formatRatio,
  formatWholeUnits,
  ratioWidth,
} from "./money-format";

const usd = (micros: string) => ({ micros, currency: "USD" });
const cents = { locale: "en-US", precision: "cents" } as const;
const exact = { locale: "en-US", precision: "exact" } as const;

describe("formatMoney", () => {
  it("prints the currency's minor units at cents precision", () => {
    expect(formatMoney(usd("2450000000"), cents)).toBe("$2,450.00");
    expect(formatMoney(usd("4130000"), cents)).toBe("$4.13");
    expect(formatMoney(usd("0"), cents)).toBe("$0.00");
    expect(formatMoney({ micros: "1234560000", currency: "JPY" }, cents)).toBe(
      "¥1,235",
    );
  });

  it("rounds half to even once", () => {
    expect(formatMoney(usd("5000"), cents)).toBe("$0.00");
    expect(formatMoney(usd("15000"), cents)).toBe("$0.02");
    expect(formatMoney(usd("25000"), cents)).toBe("$0.02");
    expect(formatMoney(usd("25001"), cents)).toBe("$0.03");
  });

  it("prints a sub-cent rate at exact precision, trimmed to the last non-zero digit and at least two", () => {
    expect(formatMoney(usd("5000"), exact)).toBe("$0.005");
    expect(formatMoney(usd("3210"), exact)).toBe("$0.00321");
    expect(formatMoney(usd("25000000"), exact)).toBe("$25.00");
  });

  it("keeps every digit past Number.MAX_SAFE_INTEGER, which a float cannot", () => {
    expect(formatMoney(usd("9007199254740993000000"), cents)).toBe(
      "$9,007,199,254,740,993.00",
    );
  });

  it("formats negatives and never prints a negative zero", () => {
    expect(formatMoney(usd("-1500000"), cents)).toBe("-$1.50");
    expect(formatMoney(usd("-0"), cents)).toBe("$0.00");
  });

  it("follows the locale's separators", () => {
    expect(
      formatMoney(
        { micros: "2450000000", currency: "EUR" },
        { locale: "de-DE", precision: "cents" },
      ),
    ).toBe("2.450,00 €");
  });

  it("refuses a display string rather than printing it as a number (negative)", () => {
    expect(() => formatMoney(usd("2,450.00"), cents)).toThrow("integer string");
    expect(() => formatMoney(usd(""), cents)).toThrow("integer string");
  });
});

describe("formatCount", () => {
  it("groups by the locale", () => {
    expect(formatCount(0, "en-US")).toBe("0");
    expect(formatCount(58450, "en-US")).toBe("58,450");
    expect(formatCount(58450, "de-DE")).toBe("58.450");
  });
});

describe("formatWholeUnits", () => {
  it("prints a count from its digits, past what a double holds exactly", () => {
    expect(formatWholeUnits("50", "en-US")).toBe("50");
    expect(formatWholeUnits("9007199254740993", "en-US")).toBe(
      "9,007,199,254,740,993",
    );
    expect(formatWholeUnits("0", "en-US")).toBe("0");
  });

  it("refuses anything but digits (negative)", () => {
    expect(() => formatWholeUnits("-1", "en-US")).toThrow(/integer string/);
    expect(() => formatWholeUnits("1.5", "en-US")).toThrow(/integer string/);
    expect(() => formatWholeUnits("", "en-US")).toThrow(/integer string/);
  });
});

describe("ratioWidth", () => {
  it("prints a 0…1 ratio as a CSS length, to a tenth of a percent", () => {
    expect(ratioWidth(0.4567)).toBe("45.7%");
    expect(ratioWidth(1)).toBe("100%");
    expect(ratioWidth(0)).toBe("0%");
  });

  it("clamps a ratio outside 0…1 (negative)", () => {
    expect(ratioWidth(1.4)).toBe("100%");
    expect(ratioWidth(-0.2)).toBe("0%");
  });
});

describe("formatClock", () => {
  it("reads whole seconds as m:ss", () => {
    expect(formatClock(0, "en-US")).toBe("0:00");
    expect(formatClock(65.9, "en-US")).toBe("1:05");
    expect(formatClock(600, "en-US")).toBe("10:00");
  });

  it("reads a negative duration as 0:00 (negative)", () => {
    expect(formatClock(-30, "en-US")).toBe("0:00");
  });
});

describe("formatRatio", () => {
  it("prints a 0..1 ratio as a percentage with at most one decimal", () => {
    expect(formatRatio(0.4567, "en-US")).toBe("45.7%");
    expect(formatRatio(0.81, "en-US")).toBe("81%");
    expect(formatRatio(0, "en-US")).toBe("0%");
  });
});

describe("formatWholeUnits", () => {
  it("prints a count from its digits, past what a double holds exactly", () => {
    expect(formatWholeUnits("50", "en-US")).toBe("50");
    expect(formatWholeUnits("9007199254740993", "en-US")).toBe(
      "9,007,199,254,740,993",
    );
    expect(formatWholeUnits("0", "en-US")).toBe("0");
  });

  it("refuses anything but digits (negative)", () => {
    expect(() => formatWholeUnits("-1", "en-US")).toThrow(/integer string/);
    expect(() => formatWholeUnits("1.5", "en-US")).toThrow(/integer string/);
    expect(() => formatWholeUnits("", "en-US")).toThrow(/integer string/);
  });
});

describe("ratioWidth", () => {
  it("prints a 0…1 ratio as a CSS length, to a tenth of a percent", () => {
    expect(ratioWidth(0.4567)).toBe("45.7%");
    expect(ratioWidth(1)).toBe("100%");
    expect(ratioWidth(0)).toBe("0%");
  });

  it("clamps a ratio outside 0…1 (negative)", () => {
    expect(ratioWidth(1.4)).toBe("100%");
    expect(ratioWidth(-0.2)).toBe("0%");
  });
});

describe("formatClock", () => {
  it("reads whole seconds as m:ss", () => {
    expect(formatClock(0, "en-US")).toBe("0:00");
    expect(formatClock(65.9, "en-US")).toBe("1:05");
    expect(formatClock(600, "en-US")).toBe("10:00");
  });

  it("reads a negative duration as 0:00 (negative)", () => {
    expect(formatClock(-30, "en-US")).toBe("0:00");
  });
});

describe("formatDuration", () => {
  it("reads milliseconds under a second, so a 41 ms step does not read as zero", () => {
    expect(formatDuration(41, "en")).toBe("41 ms");
    expect(formatDuration(999, "en")).toBe("999 ms");
  });

  it("reads seconds with one decimal under ten, and whole seconds above it", () => {
    expect(formatDuration(4200, "en")).toBe("4.2 s");
    expect(formatDuration(41_000, "en")).toBe("41 s");
  });

  it("reads a minute and beyond on the clock", () => {
    expect(formatDuration(60_000, "en")).toBe("1:00");
    expect(formatDuration(127_000, "en")).toBe("2:07");
  });

  it("reads a negative duration as zero rather than as a negative one (negative)", () => {
    expect(formatDuration(-5, "en")).toBe("0 ms");
  });
});

describe("formatByteSize", () => {
  it("prints a size in the largest decimal unit at or above 1", () => {
    expect(formatByteSize(512, "en")).toBe("512 byte");
    expect(formatByteSize(48_210, "en")).toBe("48.2 kB");
    expect(formatByteSize(3_100_000, "en")).toBe("3.1 MB");
    expect(formatByteSize(2_000_000_000, "en")).toBe("2 GB");
  });
});
