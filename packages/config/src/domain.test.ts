// domain.test.ts
//
// Unit tests for geo.ts + domain.ts helpers in @oxagen/config.
//
// Strategy:
//  - Derive expected collection sizes from the imported constants, never
//    hardcode counts (guards against drift).
//  - Assert both positive and negative cases for validator functions.
//  - Assert config-level invariants (no duplicate values, parity between
//    *_VALUES and *_OPTIONS arrays).

import { describe, expect, it } from "vitest";
import {
  isValidCountryCode,
  isValidUsStateCode,
  COUNTRY_OPTIONS,
  US_STATE_OPTIONS,
} from "./geo";
import {
  ORG_TYPE_VALUES,
  ORG_TYPE_OPTIONS,
  INDUSTRY_VALUES,
  INDUSTRY_OPTIONS,
  EMPLOYEE_SIZE_VALUES,
  EMPLOYEE_SIZE_OPTIONS,
} from "./domain";

// ---------------------------------------------------------------------------
// isValidCountryCode
// ---------------------------------------------------------------------------

describe("isValidCountryCode", () => {
  it("'US' → true (exact uppercase match)", () => {
    expect(isValidCountryCode("US")).toBe(true);
  });

  it("'us' → true (case-insensitive)", () => {
    expect(isValidCountryCode("us")).toBe(true);
  });

  it("'XX' → false (not a real country code)", () => {
    expect(isValidCountryCode("XX")).toBe(false);
  });

  it("'' → false (empty string is invalid)", () => {
    // Empty string: toUpperCase() = "", not in the Set
    expect(isValidCountryCode("")).toBe(false);
  });

  it("'USA' → false (3-letter codes are not ISO 3166-1 alpha-2)", () => {
    expect(isValidCountryCode("USA")).toBe(false);
  });

  it("'GB' → true (United Kingdom)", () => {
    expect(isValidCountryCode("GB")).toBe(true);
  });

  it("'gb' → true (case-insensitive, UK)", () => {
    expect(isValidCountryCode("gb")).toBe(true);
  });

  it("'ZZ' → false (invalid code)", () => {
    expect(isValidCountryCode("ZZ")).toBe(false);
  });

  // Negative: passing null/undefined to a function typed as (string) throws
  // at the JS level because .toUpperCase() would be called on non-string.
  it("passing null throws (unguarded runtime behaviour)", () => {
    // The function is typed (code: string) — passing null is an unguarded call.
    // We assert the real runtime behaviour rather than silently swallowing it.
    expect(() => isValidCountryCode(null as unknown as string)).toThrow();
  });

  it("passing undefined throws (unguarded runtime behaviour)", () => {
    expect(() => isValidCountryCode(undefined as unknown as string)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isValidUsStateCode
// ---------------------------------------------------------------------------

describe("isValidUsStateCode", () => {
  it("'CA' → true (California)", () => {
    expect(isValidUsStateCode("CA")).toBe(true);
  });

  it("'ca' → true (case-insensitive)", () => {
    expect(isValidUsStateCode("ca")).toBe(true);
  });

  it("'DC' → true (District of Columbia is included)", () => {
    expect(isValidUsStateCode("DC")).toBe(true);
  });

  it("'PR' → false (Puerto Rico is NOT in the state list)", () => {
    // US_STATE_OPTIONS only includes 50 states + DC; territories are excluded.
    const values = US_STATE_OPTIONS.map((s) => s.value.toUpperCase());
    expect(values).not.toContain("PR");
    expect(isValidUsStateCode("PR")).toBe(false);
  });

  it("'' → false (empty string invalid)", () => {
    expect(isValidUsStateCode("")).toBe(false);
  });

  it("passing null throws (unguarded runtime behaviour)", () => {
    expect(() => isValidUsStateCode(null as unknown as string)).toThrow();
  });

  it("passing undefined throws (unguarded runtime behaviour)", () => {
    expect(() => isValidUsStateCode(undefined as unknown as string)).toThrow();
  });

  it("'XX' → false (not a US state code)", () => {
    expect(isValidUsStateCode("XX")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COUNTRY_OPTIONS: no duplicate values
// ---------------------------------------------------------------------------

describe("COUNTRY_OPTIONS integrity", () => {
  it("has no duplicate values (each country code appears exactly once)", () => {
    const values = COUNTRY_OPTIONS.map((c) => c.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("every value is exactly 2 uppercase letters", () => {
    for (const { value } of COUNTRY_OPTIONS) {
      expect(value).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("includes 'US'", () => {
    expect(COUNTRY_OPTIONS.some((c) => c.value === "US")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ORG_TYPE_VALUES parity with ORG_TYPE_OPTIONS
// ---------------------------------------------------------------------------

describe("ORG_TYPE_VALUES ↔ ORG_TYPE_OPTIONS parity", () => {
  it("ORG_TYPE_VALUES exactly equals ORG_TYPE_OPTIONS.map(o => o.value)", () => {
    const fromOptions = ORG_TYPE_OPTIONS.map((o) => o.value);
    // Both arrays must have the same members in the same order.
    expect([...ORG_TYPE_VALUES]).toEqual(fromOptions);
  });

  it("ORG_TYPE_VALUES has no duplicates", () => {
    const unique = new Set(ORG_TYPE_VALUES);
    expect(unique.size).toBe(ORG_TYPE_VALUES.length);
  });
});

// ---------------------------------------------------------------------------
// INDUSTRY parity
// ---------------------------------------------------------------------------

describe("INDUSTRY_VALUES ↔ INDUSTRY_OPTIONS parity", () => {
  it("every INDUSTRY_OPTIONS value is in INDUSTRY_VALUES", () => {
    const valSet = new Set<string>(INDUSTRY_VALUES);
    for (const { value } of INDUSTRY_OPTIONS) {
      expect(
        valSet.has(value),
        `INDUSTRY_OPTIONS value '${value}' missing from INDUSTRY_VALUES`,
      ).toBe(true);
    }
  });

  it("every INDUSTRY_VALUES entry is in INDUSTRY_OPTIONS", () => {
    const optSet = new Set<string>(INDUSTRY_OPTIONS.map((o) => o.value));
    for (const val of INDUSTRY_VALUES) {
      expect(
        optSet.has(val),
        `INDUSTRY_VALUES entry '${val}' missing from INDUSTRY_OPTIONS`,
      ).toBe(true);
    }
  });

  it("INDUSTRY_VALUES has no duplicates", () => {
    const unique = new Set<string>(INDUSTRY_VALUES);
    expect(unique.size).toBe(INDUSTRY_VALUES.length);
  });

  it("INDUSTRY_OPTIONS has no duplicate values", () => {
    const values = INDUSTRY_OPTIONS.map((o) => o.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// EMPLOYEE_SIZE parity
// ---------------------------------------------------------------------------

describe("EMPLOYEE_SIZE_VALUES ↔ EMPLOYEE_SIZE_OPTIONS parity", () => {
  it("every EMPLOYEE_SIZE_OPTIONS value is in EMPLOYEE_SIZE_VALUES", () => {
    const valSet = new Set<string>(EMPLOYEE_SIZE_VALUES);
    for (const { value } of EMPLOYEE_SIZE_OPTIONS) {
      expect(
        valSet.has(value),
        `EMPLOYEE_SIZE_OPTIONS value '${value}' missing from EMPLOYEE_SIZE_VALUES`,
      ).toBe(true);
    }
  });

  it("every EMPLOYEE_SIZE_VALUES entry is in EMPLOYEE_SIZE_OPTIONS", () => {
    const optSet = new Set<string>(EMPLOYEE_SIZE_OPTIONS.map((o) => o.value));
    for (const val of EMPLOYEE_SIZE_VALUES) {
      expect(
        optSet.has(val),
        `EMPLOYEE_SIZE_VALUES entry '${val}' missing from EMPLOYEE_SIZE_OPTIONS`,
      ).toBe(true);
    }
  });

  it("EMPLOYEE_SIZE_VALUES has no duplicates", () => {
    const unique = new Set<string>(EMPLOYEE_SIZE_VALUES);
    expect(unique.size).toBe(EMPLOYEE_SIZE_VALUES.length);
  });

  it("EMPLOYEE_SIZE_OPTIONS has no duplicate values", () => {
    const values = EMPLOYEE_SIZE_OPTIONS.map((o) => o.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
