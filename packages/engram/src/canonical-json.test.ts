/**
 * Tests for canonical-json.ts (P1-6).
 *
 * The invariant: serialization is stable under key reordering, so
 * content-addressed IDs don't fork on cosmetic key-order differences.
 */
import { describe, it, expect } from "vitest";
import { CanonicalJsonError, canonicalStringify } from "./canonical-json";

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

/**
 * The inequality direction. Content addressing needs "different value =>
 * different bytes" as much as it needs the equality half, and every test above
 * this block asserts only the equality half. A serializer that renders two
 * distinct values identically hands them one record id, and the second write
 * dedups onto the first.
 */
describe("canonicalStringify distinguishes values that differ", () => {
  it("gives two instants two serializations, each its ISO string", () => {
    const a = canonicalStringify(new Date(0));
    const b = canonicalStringify(new Date(86_400_000));
    expect(a).not.toBe(b);
    expect(a).toBe('"1970-01-01T00:00:00.000Z"');
    expect(b).toBe('"1970-01-02T00:00:00.000Z"');
  });

  it("gives two records differing only in a Date field two ids", () => {
    const a = { subject: "deploy", observedAt: new Date(0) };
    const b = { subject: "deploy", observedAt: new Date(86_400_000) };
    expect(canonicalStringify(a)).not.toBe(canonicalStringify(b));
  });

  it("honours toJSON on a class, as JSON.stringify does", () => {
    class Money {
      constructor(readonly cents: number) {}
      toJSON() {
        return { cents: this.cents };
      }
    }
    expect(canonicalStringify(new Money(1))).toBe('{"cents":1}');
    expect(canonicalStringify(new Money(1))).not.toBe(
      canonicalStringify(new Money(2)),
    );
  });

  it("refuses a Map rather than collapsing it to {}", () => {
    expect(() => canonicalStringify(new Map([["a", 1]]))).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalStringify({ tags: new Map([["a", 1]]) })).toThrow(
      /tags: non-plain object \(Map\)/,
    );
  });

  it("refuses a Set rather than collapsing it to {}", () => {
    expect(() => canonicalStringify(new Set([1, 2, 3]))).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalStringify({ tags: new Set([1]) })).toThrow(
      /tags: non-plain object \(Set\)/,
    );
  });

  it("refuses a RegExp rather than collapsing it to {}", () => {
    expect(() => canonicalStringify({ pattern: /x/g })).toThrow(
      /pattern: non-plain object \(RegExp\)/,
    );
  });

  it("refuses a class instance that has no toJSON", () => {
    class Opaque {
      #secret = 1;
      read() {
        return this.#secret;
      }
    }
    expect(() => canonicalStringify(new Opaque())).toThrow(
      /non-plain object \(Opaque\)/,
    );
  });

  it("names the path of the offending value", () => {
    try {
      canonicalStringify({ outer: { list: [{ when: new Set() }] } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).path).toBe("outer.list.0.when");
    }
  });

  it("refuses a cycle instead of overflowing the stack", () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle["self"] = cycle;
    expect(() => canonicalStringify(cycle)).toThrow(/circular reference/);
  });

  it("refuses a toJSON that returns its own receiver", () => {
    const spinner = {
      toJSON() {
        return spinner;
      },
    };
    expect(() => canonicalStringify(spinner)).toThrow(/own receiver/);
  });
});

/**
 * Controls. These are the shapes that already hashed correctly, and they must
 * keep the exact bytes they had — a repair to the exotic-value branches that
 * moved plain-value bytes would re-id every record already in the store.
 */
describe("canonicalStringify leaves plain values byte-identical", () => {
  it("keeps distinct plain values distinct", () => {
    expect(canonicalStringify({ n: 1 })).not.toBe(canonicalStringify({ n: 2 }));
    expect(canonicalStringify({ t: "2026-01-01" })).not.toBe(
      canonicalStringify({ t: "2026-08-27" }),
    );
  });

  it("emits the bytes it emitted before Date/Map/Set were handled", () => {
    expect(
      canonicalStringify({
        kind: "semantic",
        namespace: { tenantId: "t1" },
        body: { subject: "deploy", tags: ["a", "b"], count: 3, ok: true },
      }),
    ).toBe(
      '{"body":{"count":3,"ok":true,"subject":"deploy","tags":["a","b"]},' +
        '"kind":"semantic","namespace":{"tenantId":"t1"}}',
    );
  });

  it("keeps a null-prototype object on the plain-object branch", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["b"] = 1;
    bare["a"] = 2;
    expect(canonicalStringify(bare)).toBe('{"a":2,"b":1}');
  });
});
