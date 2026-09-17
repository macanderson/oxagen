import { describe, it, expect } from "vitest";
import {
  formatMoney,
  formatUsd,
  formatWindow,
  moneyFromUsd,
  usdFromMoney,
  validateLimitUsd,
  validateWindowDays,
} from "./spend-budget-format";

describe("formatUsd", () => {
  it("formats a whole-dollar amount with the standard USD currency format", () => {
    expect(formatUsd(500)).toBe("$500.00");
  });

  it("formats a fractional amount to two decimal places", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatWindow", () => {
  it("formats a same-year window without repeating the year twice", () => {
    expect(
      formatWindow("2026-07-01T00:00:00.000Z", "2026-07-21T00:00:00.000Z"),
    ).toBe("Jul 1 – Jul 21, 2026");
  });

  it("formats a cross-year window with both years shown", () => {
    expect(
      formatWindow("2025-12-15T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
    ).toBe("Dec 15, 2025 – Jan 3, 2026");
  });

  it("falls back to the raw ISO strings on unparsable input rather than throwing", () => {
    expect(formatWindow("not-a-date", "also-not-a-date")).toBe(
      "not-a-date – also-not-a-date",
    );
  });
});

describe("validateWindowDays — mirrors the DB CHECK / contract refine", () => {
  it("rolling with a positive integer windowDays is valid", () => {
    expect(validateWindowDays("rolling", 30)).toBeNull();
  });

  it("rolling with null windowDays is invalid", () => {
    expect(validateWindowDays("rolling", null)).not.toBeNull();
  });

  it("rolling with windowDays=0 is invalid", () => {
    expect(validateWindowDays("rolling", 0)).not.toBeNull();
  });

  it("rolling with a negative windowDays is invalid", () => {
    expect(validateWindowDays("rolling", -5)).not.toBeNull();
  });

  it("rolling with a non-integer windowDays is invalid", () => {
    expect(validateWindowDays("rolling", 2.5)).not.toBeNull();
  });

  it("monthly with null windowDays is valid", () => {
    expect(validateWindowDays("monthly", null)).toBeNull();
  });

  it("monthly with a non-null windowDays is invalid", () => {
    expect(validateWindowDays("monthly", 30)).not.toBeNull();
  });
});

describe("validateLimitUsd", () => {
  it("a positive limit is valid", () => {
    expect(validateLimitUsd(1)).toBeNull();
  });

  it("null is invalid", () => {
    expect(validateLimitUsd(null)).not.toBeNull();
  });

  it("zero is invalid (must be > 0)", () => {
    expect(validateLimitUsd(0)).not.toBeNull();
  });

  it("a negative limit is invalid", () => {
    expect(validateLimitUsd(-10)).not.toBeNull();
  });

  it("NaN is invalid", () => {
    expect(validateLimitUsd(Number.NaN)).not.toBeNull();
  });
});

describe("usdFromMoney", () => {
  it("converts whole micro-units to major units", () => {
    expect(usdFromMoney({ micros: "250000000", currency: "USD" })).toBe(250);
  });

  it("keeps the sub-dollar remainder", () => {
    expect(usdFromMoney({ micros: "1234500000", currency: "USD" })).toBe(
      1234.5,
    );
  });

  it("keeps whole dollars exact past what a float division would hold", () => {
    // 10^15 micros is $10^9; the integer part is taken with BigInt, so the
    // dollars survive rather than being rounded by `Number(micros) / 1e6`.
    expect(usdFromMoney({ micros: "1000000000000000", currency: "USD" })).toBe(
      1_000_000_000,
    );
  });

  it("carries the sign of a negative amount", () => {
    expect(usdFromMoney({ micros: "-1500000", currency: "USD" })).toBe(-1.5);
  });

  it("converts zero", () => {
    expect(usdFromMoney({ micros: "0", currency: "USD" })).toBe(0);
  });
});

describe("moneyFromUsd", () => {
  it("converts major units to micro-units as a decimal string", () => {
    expect(moneyFromUsd(250)).toEqual({
      micros: "250000000",
      currency: "USD",
    });
  });

  it("rounds a sub-micro amount to the nearest micro rather than truncating", () => {
    expect(moneyFromUsd(0.0000005).micros).toBe("1");
  });

  it("round-trips through usdFromMoney", () => {
    expect(usdFromMoney(moneyFromUsd(1234.56))).toBe(1234.56);
  });

  it("takes a non-USD currency when one is given", () => {
    expect(moneyFromUsd(10, "EUR").currency).toBe("EUR");
  });
});

describe("formatMoney", () => {
  it("formats a USD amount the way formatUsd formats the same figure", () => {
    expect(formatMoney({ micros: "1234500000", currency: "USD" })).toBe(
      formatUsd(1234.5),
    );
  });

  it("formats zero", () => {
    expect(formatMoney({ micros: "0", currency: "USD" })).toBe("$0.00");
  });

  it("formats in the amount's own currency, not always USD", () => {
    const formatted = formatMoney({ micros: "1000000", currency: "EUR" });
    expect(formatted).toContain("1.00");
    expect(formatted).not.toContain("$");
  });
});
