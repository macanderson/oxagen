/**
 * The pure half of the call facts: the canonical digest a standing-approval
 * window is keyed on. `loadDeclaredTool` and `buildAutoApprovalSubject` read
 * the database and are covered in auto-approval.pg.test.ts.
 */
import { describe, expect, it } from "vitest";
import { inputDigest, UndigestibleInputError } from "./call-facts";

describe("inputDigest", () => {
  it("is stable across key order and sensitive to every value", () => {
    expect(inputDigest({ a: 1, b: 2 })).toBe(inputDigest({ b: 2, a: 1 }));
    expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }));
    expect(inputDigest({ a: [1, 2] })).not.toBe(inputDigest({ a: [2, 1] }));
    expect(inputDigest({ a: { b: 1 } })).toBe(inputDigest({ a: { b: 1 } }));
  });

  it("separates calls that differ only in a Date", () => {
    // The collision this closes. A Date has no enumerable keys, so walking
    // keys turned every one of them into {} — and the capabilities that take
    // `z.coerce.date()` fields (record_execution's startedAt/completedAt)
    // produce Dates from validated input. Two runs hours apart shared a
    // digest, so one person's approval covered a call they never saw.
    const a = { startedAt: new Date("2026-09-16T10:00:00.000Z") };
    const b = { startedAt: new Date("2026-09-16T18:30:00.000Z") };
    expect(inputDigest(a)).not.toBe(inputDigest(b));
    // Equal instants are the same call.
    expect(inputDigest(a)).toBe(
      inputDigest({ startedAt: new Date("2026-09-16T10:00:00.000Z") }),
    );
    // And a Date is not its own ISO string: encoding by value without a tag
    // would trade one collision for another.
    expect(inputDigest(a)).not.toBe(
      inputDigest({ startedAt: "2026-09-16T10:00:00.000Z" }),
    );
  });

  it("encodes the other typed values it supports by value", () => {
    expect(inputDigest({ n: 1n })).not.toBe(inputDigest({ n: 2n }));
    expect(inputDigest({ n: 1n })).toBe(inputDigest({ n: 1n }));
    // A BigInt is not the number or the string that prints the same.
    expect(inputDigest({ n: 1n })).not.toBe(inputDigest({ n: 1 }));
    expect(inputDigest({ n: 1n })).not.toBe(inputDigest({ n: "1" }));

    // Insertion order is not identity for a Map or a Set.
    expect(
      inputDigest({
        m: new Map([
          ["a", 1],
          ["b", 2],
        ]),
      }),
    ).toBe(
      inputDigest({
        m: new Map([
          ["b", 2],
          ["a", 1],
        ]),
      }),
    );
    expect(inputDigest({ s: new Set([1, 2]) })).toBe(
      inputDigest({ s: new Set([2, 1]) }),
    );
    expect(inputDigest({ s: new Set([1, 2]) })).not.toBe(
      inputDigest({ s: new Set([1, 3]) }),
    );

    expect(inputDigest({ r: /a/g })).not.toBe(inputDigest({ r: /a/i }));
    expect(inputDigest({ u: new URL("https://a.test/x") })).not.toBe(
      inputDigest({ u: new URL("https://a.test/y") }),
    );
  });

  it("refuses a value it cannot encode rather than collapsing it", () => {
    // The rule that keeps this bug from returning for the next type: an
    // unrecognised value is a refusal, not an empty object. Both consumers
    // fail closed on a throw — the gate's auto-approval hook catches and
    // declines to release, and the mandate check throws to refuse — so the
    // call goes to a person.
    class Money {
      constructor(readonly cents: number) {}
    }
    expect(() => inputDigest({ m: new Money(1) })).toThrow(
      UndigestibleInputError,
    );
    expect(() => inputDigest({ m: new Money(1) })).toThrow(/Money/);
    expect(() => inputDigest({ f: () => 1 })).toThrow(UndigestibleInputError);
    expect(() => inputDigest({ s: Symbol("x") })).toThrow(
      UndigestibleInputError,
    );
    expect(() => inputDigest({ b: new Uint8Array([1]) })).toThrow(
      UndigestibleInputError,
    );
    expect(() => inputDigest({ d: new Date("nonsense") })).toThrow(
      UndigestibleInputError,
    );
    // Two different unencodable values must never reach the point of sharing
    // a digest, which is what the throw guarantees.
    expect(() => inputDigest({ m: new Money(2) })).toThrow(
      UndigestibleInputError,
    );
  });

  it("still digests an object with a null prototype", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(inputDigest(bare)).toBe(inputDigest({ a: 1 }));
  });
});
