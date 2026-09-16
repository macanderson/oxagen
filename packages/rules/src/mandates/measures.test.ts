import { describe, expect, it } from "vitest";
import {
  amountToMicros,
  exceeds,
  periodKey,
  readMeasure,
  readPath,
  remainingAfter,
  targetAllowed,
  toolMatches,
} from "./measures";

describe("readPath", () => {
  it("walks a dot path and reports absence as undefined", () => {
    const input = { amount: { value: "12.50", currency: "USD" }, rows: 3 };
    expect(readPath(input, "amount.value")).toBe("12.50");
    expect(readPath(input, "rows")).toBe(3);
    expect(readPath(input, "amount.missing")).toBeUndefined();
    expect(readPath(input, "rows.deeper")).toBeUndefined();
    expect(readPath(null, "x")).toBeUndefined();
  });
});

describe("amountToMicros", () => {
  const micros = (raw: string | number, scale: number) => {
    const out = amountToMicros(raw, scale);
    return out.ok ? out.micros : null;
  };

  it("converts with string arithmetic at the tool's scale", () => {
    expect(micros("12.50", 2)).toBe("12500000");
    expect(micros("250", 2)).toBe("250000000");
    expect(micros(250, 2)).toBe("250000000");
    expect(micros("0", 2)).toBe("0");
    expect(micros("0.01", 2)).toBe("10000");
    // Whole-unit tools (scale 0), and fewer decimals than declared.
    expect(micros("7", 0)).toBe("7000000");
    expect(micros("1.99", 2)).toBe("1990000");
    // Beyond a float's precision, still exact.
    expect(micros("123456789012345678.99", 2)).toBe("123456789012345678990000");
  });

  it("refuses what is not a non-negative decimal", () => {
    for (const bad of ["-1", "1e3", "abc", ""]) {
      expect(amountToMicros(bad, 2)).toEqual({
        ok: false,
        reason: "not_a_number",
      });
    }
  });

  it("refuses an amount it cannot represent exactly, rather than truncating it", () => {
    // The fail-open this closes: "10.009" at scale 2 used to convert to
    // 10000000 micros — the same as "10.00" — so a ceiling at 10.00 released
    // a call the handler then executed for 10.009. The decision path and the
    // execution path read different numbers, always in the direction that
    // releases the call.
    expect(amountToMicros("10.009", 2)).toEqual({
      ok: false,
      reason: "too_precise",
    });
    expect(amountToMicros("1.999", 2)).toEqual({
      ok: false,
      reason: "too_precise",
    });
    // A scale finer than micros truncated the same way: "1.2345678" at scale
    // 7 used to convert to 1234567, dropping the last digit.
    expect(amountToMicros("1.2345678", 7)).toEqual({
      ok: false,
      reason: "too_precise",
    });
    // Exactly representable at that scale is still fine.
    expect(micros("1.234567", 7)).toBe("1234567");
    // A trailing zero past the sixth decimal carries no value, so it converts.
    expect(micros("1.2345670", 7)).toBe("1234567");
  });
});

describe("readMeasure", () => {
  const amount = { path: "amount.value", type: "amount" as const, unit: "USD" };
  const rows = { path: "rows", type: "count" as const, unit: "rows" };
  const env = {
    path: "target.env",
    type: "text" as const,
    unit: "environment",
  };

  it("reads an amount as micros, a count as whole units, a text as a target", () => {
    expect(readMeasure({ amount: { value: "12.50" } }, amount)).toEqual({
      ok: true,
      measure: { kind: "value", value: "12500000" },
    });
    expect(readMeasure({ rows: 42 }, rows)).toEqual({
      ok: true,
      measure: { kind: "value", value: "42" },
    });
    expect(readMeasure({ rows: "42" }, rows).ok).toBe(true);
    expect(readMeasure({ target: { env: "prod" } }, env)).toEqual({
      ok: true,
      measure: { kind: "target", target: "prod" },
    });
  });

  it("names why a measure cannot be read", () => {
    expect(readMeasure({}, amount)).toEqual({ ok: false, reason: "missing" });
    expect(readMeasure({ amount: { value: null } }, amount)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(readMeasure({ amount: { value: true } }, amount)).toEqual({
      ok: false,
      reason: "not_a_number",
    });
    expect(readMeasure({ amount: { value: -5 } }, amount)).toEqual({
      ok: false,
      reason: "negative",
    });
    expect(readMeasure({ rows: 1.5 }, rows)).toEqual({
      ok: false,
      reason: "not_a_number",
    });
    expect(readMeasure({ rows: -1 }, rows)).toEqual({
      ok: false,
      reason: "negative",
    });
    expect(readMeasure({ target: { env: 7 } }, env)).toEqual({
      ok: false,
      reason: "not_a_string",
    });
  });
});

describe("periodKey", () => {
  it("files a row by UTC day, ISO week or month", () => {
    const at = new Date("2026-09-14T23:30:00Z");
    expect(periodKey("daily", at)).toBe("2026-09-14");
    expect(periodKey("weekly", at)).toBe("2026-W38");
    expect(periodKey("monthly", at)).toBe("2026-09");
  });
  it("puts the first days of January in the ISO week-year they belong to", () => {
    expect(periodKey("weekly", new Date("2027-01-01T00:00:00Z"))).toBe(
      "2026-W53",
    );
    expect(periodKey("weekly", new Date("2026-12-31T00:00:00Z"))).toBe(
      "2026-W53",
    );
    expect(periodKey("daily", new Date("2027-01-01T00:00:00Z"))).toBe(
      "2027-01-01",
    );
  });
});

describe("toolMatches", () => {
  it("matches slug@version globs and a bare slug against every version", () => {
    expect(
      toolMatches(["stripe__create_payment@*"], "stripe__create_payment", 3),
    ).toBe(true);
    expect(
      toolMatches(["stripe__create_payment@2"], "stripe__create_payment", 3),
    ).toBe(false);
    expect(
      toolMatches(["stripe__create_payment"], "stripe__create_payment", 3),
    ).toBe(true);
    expect(toolMatches(["stripe__*"], "stripe__refund", 1)).toBe(true);
    expect(toolMatches(["stripe__*"], "aws__purchase", 1)).toBe(false);
    expect(toolMatches([], "x", 1)).toBe(false);
  });
});

describe("targetAllowed", () => {
  it("allow wins, then deny, then the allow list decides the default", () => {
    const spec = { allow: ["vendor:aws", "vendor:github"], deny: ["*"] };
    expect(targetAllowed("vendor:aws", spec)).toBe(true);
    expect(targetAllowed("vendor:evil", spec)).toBe(false);
    expect(targetAllowed("anything", { allow: [], deny: [] })).toBe(true);
    expect(targetAllowed("prod", { allow: [], deny: ["prod"] })).toBe(false);
    expect(targetAllowed("staging", { allow: ["stag*"], deny: [] })).toBe(true);
    expect(targetAllowed("prod", { allow: ["stag*"], deny: [] })).toBe(false);
  });
});

describe("integer-string arithmetic", () => {
  it("compares and moves balances without a float", () => {
    expect(exceeds("250000001", "250000000")).toBe(true);
    expect(exceeds("250000000", "250000000")).toBe(false);
    expect(remainingAfter("2000000000", 250000000n)).toBe("1750000000");
    expect(remainingAfter("2000000000", 0n)).toBe("2000000000");
    // A ceiling lowered under what the period already drew reads as zero.
    expect(remainingAfter("500000000", 1000000000n)).toBe("0");
    expect(exceeds("100000000000000000001", "100000000000000000000")).toBe(
      true,
    );
  });
});
