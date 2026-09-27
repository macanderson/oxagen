/**
 * The canonical text every Tacho digest is taken over (audit finding W-09,
 * #3944).
 *
 * `canonicalize@1.0.8` wrote an object with a member named `toJSON` through
 * `JSON.stringify`, keys in insertion order, and everything inside it the
 * same way. A host can put that key in an event, as an attribute name, and
 * the digest then depended on the order a store handed the keys back in.
 */
import { describe, expect, it } from "vitest";
import { hashEvent, sealEvent, GENESIS_CURSOR, verifyChain } from "./chain";
import {
  digestBytes,
  digestJcs,
  hasToJsonMember,
  jcs,
  type JsonValue,
  legacyJcs,
} from "./digest";
import { minimalSession, unsealed } from "./test-helpers";

describe("jcs", () => {
  it("sorts an object with a member named toJSON, and everything inside it", () => {
    const value = { z: 3, toJSON: "data", a: { y: 1, b: [{ d: 1, c: 2 }] } };
    expect(jcs(value)).toBe(
      '{"a":{"b":[{"c":2,"d":1}],"y":1},"toJSON":"data","z":3}',
    );
    // The text `@oxagen/run-evidence` writes for the same value
    // (run-evidence/src/digest.test.ts, "treats an own non-function toJSON
    // property as ordinary JSON data").
    expect(jcs({ z: 3, toJSON: "data", a: 1 })).toBe(
      '{"a":1,"toJSON":"data","z":3}',
    );
  });

  it("writes the same text whatever order the keys arrive in", () => {
    expect(jcs({ toJSON: "x", a: "y" })).toBe(jcs({ a: "y", toJSON: "x" }));
    expect(digestJcs({ attrs: { toJSON: "x", a: "y" } })).toBe(
      digestJcs({ attrs: { a: "y", toJSON: "x" } }),
    );
  });

  it("writes the RFC 8785 example", () => {
    // RFC 8785 section 3.2.3.
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as JsonValue;
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("writes every value with no toJSON member exactly as the text before it did", () => {
    for (const event of minimalSession()) {
      const value = JSON.parse(JSON.stringify(event)) as JsonValue;
      expect(hasToJsonMember(value)).toBe(false);
      expect(jcs(value)).toBe(legacyJcs(value));
    }
    for (const value of [null, true, 0, -0, 1e21, "a b", [], {}, [1, "x"]])
      expect(jcs(value as JsonValue)).toBe(legacyJcs(value as JsonValue));
  });

  it("keeps the text an older build wrote, for a hash it sealed", () => {
    const value = { z: 3, toJSON: "data", a: { y: 1, b: 2 } };
    expect(legacyJcs(value)).toBe('{"z":3,"toJSON":"data","a":{"y":1,"b":2}}');
    expect(hasToJsonMember(value)).toBe(true);
    expect(hasToJsonMember([{ a: [{ toJSON: 1 }] }])).toBe(true);
    // A null member was treated as absent, so nothing differs.
    expect(hasToJsonMember({ toJSON: null })).toBe(false);
  });

  it("refuses a value with no JSON text", () => {
    expect(() => jcs(undefined as unknown as JsonValue)).toThrow(TypeError);
  });
});

describe("an event whose attributes name toJSON", () => {
  const event = () =>
    sealEvent(
      unsealed(
        "agent_start",
        { model: "claude-haiku-4-5-20251001", session_start_source: "startup" },
        { attrs: { toJSON: "x", a: "y" } },
      ),
      GENESIS_CURSOR,
    ).event;

  it("verifies after a store hands its attributes back in another order", () => {
    const sealed = event();
    const stored = { ...sealed, attrs: { a: "y", toJSON: "x" } };
    expect(verifyChain([stored])).toMatchObject({ ok: true });
  });

  it("verifies when an older build sealed it, in the order it was sealed", () => {
    const sealed = event();
    const { hash: _hash, ...rest } = sealed;
    const legacy = digestBytes(
      legacyJcs(JSON.parse(JSON.stringify(rest)) as JsonValue),
    );
    expect(legacy).not.toBe(hashEvent(rest));
    const older = { ...sealed, hash: legacy };
    expect(verifyChain([older])).toMatchObject({ ok: true });
    // The older form holds only for the bytes it was taken over.
    expect(
      verifyChain([{ ...older, attrs: { a: "y", toJSON: "x" } }]),
    ).toMatchObject({ ok: false });
  });
});
