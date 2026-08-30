/**
 * tool-call-card.test.ts
 *
 * Tests for the exported pure helpers from tool-call-card.tsx:
 *   - safeJson: serialises values to JSON safely
 *   - formatDuration: formats ms durations to human-readable strings
 */

import { describe, it, expect } from "vitest";
import { safeJson, formatDuration } from "./tool-call-card";

// ── safeJson ──────────────────────────────────────────────────────────────────

describe("safeJson", () => {
  it("serialises a plain object", () => {
    expect(safeJson({ a: 1, b: "hello" })).toBe(
      '{\n  "a": 1,\n  "b": "hello"\n}',
    );
  });

  it("serialises an array", () => {
    expect(safeJson([1, 2, 3])).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("serialises null", () => {
    expect(safeJson(null)).toBe("null");
  });

  it("serialises a string value", () => {
    expect(safeJson("hello")).toBe('"hello"');
  });

  it("serialises a number", () => {
    expect(safeJson(42)).toBe("42");
  });

  it("falls back to String() for circular references", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    // JSON.stringify throws on circular; safeJson must not throw
    const result = safeJson(obj);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("does not throw for undefined input (JSON.stringify returns undefined)", () => {
    // JSON.stringify(undefined) returns JS undefined without throwing.
    // safeJson returns that undefined without blowing up.
    expect(() => safeJson(undefined)).not.toThrow();
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats sub-second durations with 'ms' suffix", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats durations between 1s and 59.9s with one decimal place and 's' suffix", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59999)).toBe("60.0s");
  });

  it("formats durations of exactly 1 minute as '1m 0s'", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("formats multi-minute durations with minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_661_000)).toBe("61m 1s");
  });

  it("handles exact minute boundaries", () => {
    expect(formatDuration(120_000)).toBe("2m 0s");
  });
});
