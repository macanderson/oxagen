import { describe, expect, it } from "vitest";
import { safeStableStringify, sha256Hex, stableStringify } from "./hash.js";

describe("stableStringify", () => {
  it("serializes structurally-equal objects identically regardless of key order", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (order is meaning)", () => {
    expect(stableStringify([2, 1])).toBe("[2,1]");
  });

  it("handles primitives and null", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(7)).toBe("7");
  });
});

describe("sha256Hex", () => {
  it("is deterministic and 64 hex chars", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("hello")).toBe(h);
    expect(sha256Hex("hello!")).not.toBe(h);
  });
});

describe("safeStableStringify", () => {
  it("stringifies plain values like stableStringify", () => {
    expect(safeStableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("never throws on cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => safeStableStringify(cyclic)).not.toThrow();
    expect(typeof safeStableStringify(cyclic)).toBe("string");
  });

  it("falls back to String() for undefined", () => {
    expect(safeStableStringify(undefined)).toBe("undefined");
  });
});
