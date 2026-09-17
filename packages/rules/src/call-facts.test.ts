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

  it("no user input can produce the encoder's output", () => {
    // The property, stated as a property. The markers alone were not enough:
    // a tag moved the collision out of the value space and into the key
    // space, and `record_execution` takes `inputPayload: z.unknown()`, so the
    // key space is caller-controlled.
    //
    // Escaping makes the map injective: a marker is exactly one `$` followed
    // by a name, and a user key of n leading `$` (n >= 1) becomes n + 1, so a
    // user key can only ever arrive with two or more.
    const realDate = { startedAt: new Date("2026-09-16T10:00:00.000Z") };
    const forged = { startedAt: { $date: "2026-09-16T10:00:00.000Z" } };
    expect(inputDigest(realDate)).not.toBe(inputDigest(forged));

    // Both directions the escape has to keep apart, including the one a naive
    // non-idempotent escape gets wrong: a user object that ALREADY contains
    // `$$date` must stay distinct from the escaped form of `{$date: …}`.
    const one = { v: { $date: "x" } };
    const two = { v: { $$date: "x" } };
    const three = { v: { $$$date: "x" } };
    const digests = [one, two, three].map(inputDigest);
    expect(new Set(digests).size).toBe(3);

    // The same for every other marker, so this is a rule rather than a
    // special case for dates.
    expect(inputDigest({ n: 1n })).not.toBe(
      inputDigest({ n: { $bigint: "1" } }),
    );
    expect(inputDigest({ s: new Set([1]) })).not.toBe(
      inputDigest({ s: { $set: [1] } }),
    );
    expect(inputDigest({ m: new Map([["a", 1]]) })).not.toBe(
      inputDigest({ m: { $map: [["a", 1]] } }),
    );
    expect(inputDigest({ r: /a/g })).not.toBe(
      inputDigest({ r: { $regexp: ["a", "g"] } }),
    );
    expect(inputDigest({ u: new URL("https://a.test/") })).not.toBe(
      inputDigest({ u: { $url: "https://a.test/" } }),
    );

    // Escaping only touches keys that could be mistaken for a marker; an
    // ordinary key with a `$` inside it is left alone.
    expect(inputDigest({ a$b: 1 })).toBe(inputDigest({ a$b: 1 }));
    expect(inputDigest({ a$b: 1 })).not.toBe(inputDigest({ a$$b: 1 }));
  });

  it("does not let JSON erase a value into a collision", () => {
    // A third axis, and different from the first two: these are not values
    // colliding with a marker, they are values JSON DELETES. The escaping
    // property does not cover them because the loss happens before any marker
    // is involved. The rule is the same one extended — every value either has
    // an unforgeable encoding or fails closed.
    //
    // `JSON.stringify` drops an undefined property and rewrites an undefined
    // array element as null, so all of these used to collide.
    expect(inputDigest({})).not.toBe(inputDigest({ x: undefined }));
    expect(inputDigest({ x: undefined })).not.toBe(inputDigest({ x: null }));
    expect(inputDigest([undefined])).not.toBe(inputDigest([null]));
    // A sparse array's hole is skipped by .map and survives as null. Built
    // rather than written as a literal, so the file needs no lint exemption
    // for the sparseness that is the point of the case.
    const sparse: unknown[] = [1];
    sparse.length = 2;
    sparse.push(3);
    expect(inputDigest(sparse)).not.toBe(inputDigest([1, null, 3]));
    // Equal shapes still agree, so this is not just "everything differs".
    expect(inputDigest({ x: undefined })).toBe(inputDigest({ x: undefined }));

    // The encoding is unforgeable like the rest: a user object shaped like it
    // escapes clear of it.
    expect(inputDigest({ x: undefined })).not.toBe(
      inputDigest({ x: { $undefined: true } }),
    );

    // Non-finite numbers all serialise as null, so they are refused rather
    // than given an encoding — they have no business in a capability input.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => inputDigest({ n: bad })).toThrow(UndigestibleInputError);
    }
    expect(() => inputDigest({ n: Number.NaN })).toThrow(/non-finite/);
  });

  it("still digests an object with a null prototype", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(inputDigest(bare)).toBe(inputDigest({ a: 1 }));
  });
});
