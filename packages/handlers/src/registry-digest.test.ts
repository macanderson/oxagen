import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  sha256Hex,
} from "./registry-digest";

describe("registry-digest", () => {
  it("canonicalJson is key-order independent", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("canonicalJson preserves array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("canonicalJson sorts keys inside array elements", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("sha256Hex produces the known digest of the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("different canonical rows produce different digests", () => {
    expect(sha256Hex(canonicalJson({ seq: 1 }))).not.toBe(
      sha256Hex(canonicalJson({ seq: 2 })),
    );
  });
});

/**
 * The inequality direction. A promotion ledger entry is re-verified against its
 * predecessor by digest, so two different entries sharing one digest is the
 * failure that matters — and every test above asserts only that equal values
 * digest equally, which was never the broken half (ADR-041).
 */
describe("registry-digest distinguishes values that differ", () => {
  it("digests two instants differently, each as its ISO string", () => {
    expect(canonicalJson({ at: new Date(0) })).toBe(
      '{"at":"1970-01-01T00:00:00.000Z"}',
    );
    expect(canonicalJson({ at: new Date(0) })).not.toBe(
      canonicalJson({ at: new Date(86_400_000) }),
    );
  });

  it("gives two promotions differing only in a timestamp two digests", () => {
    const first = sha256Hex(
      canonicalJson({ recordId: "r1", promotedAt: new Date(0) }),
    );
    const second = sha256Hex(
      canonicalJson({ recordId: "r1", promotedAt: new Date(86_400_000) }),
    );
    expect(first).not.toBe(second);
  });

  it("refuses a Map, a Set and a RegExp rather than collapsing them", () => {
    expect(() => canonicalJson({ m: new Map([["a", 1]]) })).toThrow(
      /m: non-plain object \(Map\)/,
    );
    expect(() => canonicalJson({ s: new Set([1]) })).toThrow(
      /s: non-plain object \(Set\)/,
    );
    expect(() => canonicalJson({ r: /x/g })).toThrow(
      /r: non-plain object \(RegExp\)/,
    );
  });

  it("names the path of the offending value", () => {
    try {
      canonicalJson({ outer: [{ tags: new Set() }] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).path).toBe("outer.0.tags");
    }
  });

  it("refuses a cycle instead of overflowing the stack", () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle["self"] = cycle;
    expect(() => canonicalJson(cycle)).toThrow(/circular reference/);
  });

  it("leaves plain values on the bytes they already had", () => {
    expect(
      canonicalJson({ b: 1, a: { d: 2, c: 3 }, list: [1, "two", null] }),
    ).toBe('{"a":{"c":3,"d":2},"b":1,"list":[1,"two",null]}');
  });
});
