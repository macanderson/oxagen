import { describe, it, expect } from "vitest";
import {
  detectKind,
  formatPropertyValue,
  humanizeKey,
  truncate,
  formatConfidence,
} from "./format";

describe("detectKind", () => {
  it("classifies null and undefined as null", () => {
    expect(detectKind(null)).toBe("null");
    expect(detectKind(undefined)).toBe("null");
  });
  it("classifies primitives", () => {
    expect(detectKind(true)).toBe("boolean");
    expect(detectKind(42)).toBe("number");
    expect(detectKind("hello")).toBe("string");
  });
  it("classifies ISO dates", () => {
    expect(detectKind("2026-06-21")).toBe("date");
    expect(detectKind("2026-06-21T10:30:00Z")).toBe("date");
  });
  it("classifies urls", () => {
    expect(detectKind("https://example.com/x")).toBe("url");
    expect(detectKind("http://a.b")).toBe("url");
  });
  it("classifies arrays and objects", () => {
    expect(detectKind([1, 2])).toBe("array");
    expect(detectKind({ a: 1 })).toBe("object");
  });
});

describe("formatPropertyValue", () => {
  it("renders null as an em dash", () => {
    expect(formatPropertyValue(null)).toBe("—");
  });
  it("renders booleans as Yes/No", () => {
    expect(formatPropertyValue(true)).toBe("Yes");
    expect(formatPropertyValue(false)).toBe("No");
  });
  it("formats numbers with separators", () => {
    expect(formatPropertyValue(1000)).toBe(
      new Intl.NumberFormat().format(1000),
    );
  });
  it("formats arrays as comma lists and empty arrays as a dash", () => {
    expect(formatPropertyValue(["a", "b"])).toBe("a, b");
    expect(formatPropertyValue([])).toBe("—");
  });
  it("serialises objects to JSON", () => {
    expect(formatPropertyValue({ a: 1 })).toBe('{"a":1}');
  });
  it("renders an ISO date as a localized string", () => {
    const out = formatPropertyValue("2026-06-21T10:30:00Z");
    expect(out).not.toBe("2026-06-21T10:30:00Z");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("humanizeKey", () => {
  it("splits camelCase", () => {
    expect(humanizeKey("displayName")).toBe("Display name");
  });
  it("splits snake_case and kebab-case", () => {
    expect(humanizeKey("created_at")).toBe("Created at");
    expect(humanizeKey("source-id")).toBe("Source id");
  });
  it("returns the original for an empty string", () => {
    expect(humanizeKey("")).toBe("");
  });
});

describe("truncate", () => {
  it("leaves short strings intact", () => {
    expect(truncate("short", 40)).toBe("short");
  });
  it("truncates long strings with an ellipsis", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });
});

describe("formatConfidence", () => {
  it("renders a percentage", () => {
    expect(formatConfidence(0.873)).toBe("87%");
  });
  it("clamps out-of-range values", () => {
    expect(formatConfidence(1.5)).toBe("100%");
    expect(formatConfidence(-0.5)).toBe("0%");
  });
});
