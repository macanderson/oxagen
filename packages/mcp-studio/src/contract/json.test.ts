// The copies, canonical bytes, and text form every lock and hash goes through.
import { sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalDigest, canonicalText, formatJson, plainJson } from "./json";

describe("plainJson", () => {
  it("drops undefined object values and writes an undefined array item as null", () => {
    const value = { a: 1, b: undefined, c: [1, undefined, { d: undefined, e: "x" }] };
    expect(plainJson(value)).toStrictEqual({ a: 1, c: [1, null, { e: "x" }] });
  });

  it("gives an object without a prototype the ordinary one", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;
    const copy = plainJson(bare);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toStrictEqual({ k: 1 });
  });

  const primitives: Array<[unknown]> = [[1], ["text"], [true], [null], [undefined]];
  it.each(primitives)("returns %s unchanged", (value) => {
    expect(plainJson(value)).toBe(value);
  });

  it("keeps a key named __proto__ as an own key, with the ordinary prototype", () => {
    const copy = plainJson(JSON.parse('{"__proto__":{"a":1},"b":2}')) as Record<string, unknown>;
    expect(Object.keys(copy)).toStrictEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toStrictEqual({ a: 1 });
  });

  it("copies every level", () => {
    const source = { a: { b: [1] } };
    const copy = plainJson(source) as typeof source;
    expect(copy).toStrictEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.a).not.toBe(source.a);
    expect(copy.a.b).not.toBe(source.a.b);
  });
});

describe("canonical form", () => {
  it("writes RFC 8785 text with keys sorted and no whitespace", () => {
    expect(canonicalText({ b: 1, a: [true, "x", null] })).toBe('{"a":[true,"x",null],"b":1}');
  });

  it("leaves out an undefined value", () => {
    expect(canonicalText({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("encodes the text as UTF-8 bytes", () => {
    expect(Array.from(canonicalBytes({ a: "é" }))).toEqual(Array.from(new TextEncoder().encode('{"a":"é"}')));
  });

  it("hashes the canonical bytes", () => {
    const value = { name: "create_refund", inputSchema: { type: "object" } };
    const digest = canonicalDigest(value);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).toBe(sha256Digest(canonicalBytes(value)));
  });

  it("gives the same digest in any key order", () => {
    expect(canonicalDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalDigest({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("hashes a key named __proto__ like any other key", () => {
    const schema = '{"properties":{"__proto__":{"type":"string"}},"type":"object"}';
    expect(canonicalText(JSON.parse(schema))).toBe(schema);
    expect(canonicalDigest(JSON.parse('{"__proto__":5,"b":2}'))).not.toBe(canonicalDigest({ b: 2 }));
  });

  it("gives a different digest for a different value", () => {
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });
});

describe("formatJson", () => {
  it("sorts keys at every depth, indents two spaces, and ends in a newline", () => {
    expect(formatJson({ b: { d: 1, c: [2, { f: 3, e: 4 }] }, a: true })).toBe(
      '{\n  "a": true,\n  "b": {\n    "c": [\n      2,\n      {\n        "e": 4,\n        "f": 3\n      }\n    ],\n    "d": 1\n  }\n}\n',
    );
  });

  it("writes the same bytes in any key order", () => {
    expect(formatJson({ z: 1, a: { y: 2, b: 3 } })).toBe(formatJson({ a: { b: 3, y: 2 }, z: 1 }));
  });

  it("drops undefined values and writes an undefined array item as null", () => {
    expect(formatJson({ a: undefined, b: [undefined] })).toBe('{\n  "b": [\n    null\n  ]\n}\n');
  });

  it("writes a key named __proto__", () => {
    expect(formatJson(JSON.parse('{"b":1,"__proto__":2}'))).toBe('{\n  "__proto__": 2,\n  "b": 1\n}\n');
  });

  it("writes an empty object on one line", () => {
    expect(formatJson({})).toBe("{}\n");
  });
});
