import { describe, it, expect } from "vitest";
import {
  parseDays,
  orderedCounts,
  formatDayShort,
  INFLUENCE_ORDER,
  COMPLIANCE_ORDER,
} from "./citations-format";

describe("parseDays", () => {
  it("returns a known preset unchanged", () => {
    expect(parseDays("7")).toBe(7);
    expect(parseDays("30")).toBe(30);
    expect(parseDays("90")).toBe(90);
  });
  it("falls back to 30 for missing, non-numeric, or unsupported values", () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays("garbage")).toBe(30);
    expect(parseDays("365")).toBe(30);
    expect(parseDays("-7")).toBe(30);
  });
  it("uses the first value when the search param is repeated", () => {
    expect(parseDays(["90", "7"])).toBe(90);
  });
});

describe("orderedCounts", () => {
  it("projects a record onto the fixed key order, defaulting missing keys to 0", () => {
    const result = orderedCounts(INFLUENCE_ORDER, { DECISIVE: 12, IGNORED: 3 });
    expect(result).toEqual([
      { key: "DECISIVE", count: 12 },
      { key: "CONTRIBUTING", count: 0 },
      { key: "CONSIDERED", count: 0 },
      { key: "IGNORED", count: 3 },
    ]);
  });
  it("ignores keys not present in the fixed order", () => {
    const result = orderedCounts(COMPLIANCE_ORDER, {
      COMPLIED: 5,
      UNKNOWN: 99,
    });
    expect(result.map((r) => r.key)).toEqual([
      "COMPLIED",
      "DISCRETION",
      "VIOLATION",
      "NA",
    ]);
    expect(result[0]).toEqual({ key: "COMPLIED", count: 5 });
  });
  it("handles an empty record", () => {
    expect(orderedCounts(INFLUENCE_ORDER, {})).toEqual([
      { key: "DECISIVE", count: 0 },
      { key: "CONTRIBUTING", count: 0 },
      { key: "CONSIDERED", count: 0 },
      { key: "IGNORED", count: 0 },
    ]);
  });
});

describe("formatDayShort", () => {
  it("renders a YYYY-MM-DD key as a short month/day label", () => {
    expect(formatDayShort("2026-07-18")).toBe("Jul 18");
  });
  it("passes malformed input through unchanged", () => {
    expect(formatDayShort("not-a-date")).toBe("not-a-date");
  });
});
