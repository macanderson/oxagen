import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./registry-digest";

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
