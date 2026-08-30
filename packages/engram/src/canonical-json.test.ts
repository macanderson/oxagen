/**
 * Tests for canonical-json.ts (P1-6).
 *
 * The invariant: serialization is stable under key reordering, so
 * content-addressed IDs don't fork on cosmetic key-order differences.
 */
import { describe, it, expect } from "vitest";
import { canonicalStringify } from "./canonical-json";

describe("canonicalStringify", () => {
  it("is invariant to object key order", () => {
    const a = canonicalStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("sorts nested object keys recursively", () => {
    const a = canonicalStringify({
      outer: { z: 1, a: 2 },
      list: [{ y: 1, x: 2 }],
    });
    const b = canonicalStringify({
      list: [{ x: 2, y: 1 }],
      outer: { a: 2, z: 1 },
    });
    expect(a).toBe(b);
  });

  it("preserves array order (order is meaningful)", () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(
      canonicalStringify([3, 2, 1]),
    );
  });

  it("drops undefined object values like JSON.stringify", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe(
      canonicalStringify({ a: 1 }),
    );
  });

  it("renders undefined/function array elements as null (positional)", () => {
    expect(canonicalStringify([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("matches JSON.stringify byte-for-byte when keys are already sorted", () => {
    const v = { a: 1, b: [2, 3], c: { d: 4 } };
    expect(canonicalStringify(v)).toBe(JSON.stringify(v));
  });

  it("serializes non-finite numbers as null (JSON semantics)", () => {
    expect(canonicalStringify({ n: NaN })).toBe('{"n":null}');
    expect(canonicalStringify({ n: Infinity })).toBe('{"n":null}');
  });

  it("handles null and primitives", () => {
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify("x")).toBe('"x"');
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(5)).toBe("5");
  });
});
