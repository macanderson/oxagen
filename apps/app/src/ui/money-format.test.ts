// Money, counts and clock readings as text: exact micros at any magnitude,
// half-even cents, trimmed exact precision, a refusal for a display string, and
// ratios as percentages.
import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatCount,
  formatMoney,
  formatRatio,
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

describe("formatRatio", () => {
  it("prints a 0..1 ratio as a percentage with at most one decimal", () => {
    expect(formatRatio(0.4567, "en-US")).toBe("45.7%");
    expect(formatRatio(0.81, "en-US")).toBe("81%");
    expect(formatRatio(0, "en-US")).toBe("0%");
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
