import { describe, expect, it } from "vitest";
import {
  NAMESPACE_PATTERN,
  deriveNamespace,
  normalizeNamespaceSeed,
} from "./namespace";

describe("normalizeNamespaceSeed", () => {
  it("lowercases and strips non-[a-z0-9]", () => {
    expect(normalizeNamespaceSeed("Capsule-Demo")).toBe("capsuledemo");
    expect(normalizeNamespaceSeed("Acme Inc. #1")).toBe("acmeinc1");
    expect(normalizeNamespaceSeed("---")).toBe("");
  });
});

describe("deriveNamespace", () => {
  const empty = new Set<string>();

  it("truncates the seed to 6 chars", () => {
    expect(deriveNamespace("capsule-demo", empty)).toBe("capsul");
    expect(deriveNamespace("maya-rivera", empty)).toBe("mayari");
  });

  it("always matches the column pattern", () => {
    for (const seed of ["capsule-demo", "a", "", "X", "1234567890", "Île"]) {
      expect(deriveNamespace(seed, empty)).toMatch(NAMESPACE_PATTERN);
    }
  });

  it("guarantees at least 2 chars for short or empty seeds", () => {
    expect(deriveNamespace("a", empty)).toBe("a0");
    expect(deriveNamespace("", empty)).toBe("00");
    // Seed with only stripped chars falls back to the pad, still ≥2.
    expect(deriveNamespace("--", empty)).toBe("00");
  });

  it("strips hyphens before truncating", () => {
    // "a-b-c-d-e-f-g" → "abcdefg" → first 6 = "abcdef".
    expect(deriveNamespace("a-b-c-d-e-f-g", empty)).toBe("abcdef");
  });

  it("appends a numeric suffix on collision, keeping total ≤ 6", () => {
    const taken = new Set(["capsul"]);
    const derived = deriveNamespace("capsule-demo", taken);
    expect(derived).toBe("capsu1");
    expect(derived.length).toBeLessThanOrEqual(6);
  });

  it("walks the suffix until a free value is found", () => {
    const taken = new Set(["capsul", "capsu1", "capsu2"]);
    expect(deriveNamespace("capsule-demo", taken)).toBe("capsu3");
  });

  it("truncates the base further as the suffix grows past one digit", () => {
    // Occupy the un-suffixed value and every single-digit suffix so the derive
    // is forced to a two-digit suffix (base truncated to 4 chars).
    const taken = new Set<string>(["capsul"]);
    for (let n = 1; n <= 9; n++) taken.add(`capsu${n}`);
    const derived = deriveNamespace("capsule-demo", taken);
    expect(derived).toBe("caps10");
    expect(derived.length).toBe(6);
    expect(derived).toMatch(NAMESPACE_PATTERN);
  });

  it("treats the taken set case-insensitively (citext parity)", () => {
    const taken = new Set(["CAPSUL"]);
    expect(deriveNamespace("capsule-demo", taken)).toBe("capsu1");
  });

  it("derives distinct namespaces for a batch of colliding seeds", () => {
    const taken = new Set<string>();
    const results: string[] = [];
    for (const slug of ["capsule-one", "capsule-two", "capsule-three"]) {
      const ns = deriveNamespace(slug, taken);
      results.push(ns);
      taken.add(ns);
    }
    expect(new Set(results).size).toBe(results.length);
    expect(results[0]).toBe("capsul");
    expect(results[1]).toBe("capsu1");
    expect(results[2]).toBe("capsu2");
  });

  it("derives a valid namespace from a uuid-hex seed (null-slug fallback)", () => {
    const hex = "f39e66a8cddc45d0b3654dd4c47752b6";
    const ns = deriveNamespace(hex, empty);
    expect(ns).toBe("f39e66");
    expect(ns).toMatch(NAMESPACE_PATTERN);
  });
});
