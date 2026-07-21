import { describe, expect, it } from "vitest";
import { hashArtifact, hashCanonicalJson } from "./hash";

describe("canonical hashes", () => {
  it("is stable across structured object key order", () => {
    expect(hashCanonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashCanonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("rejects values that cannot be contracted", () => {
    expect(() => hashCanonicalJson({ bad: undefined })).toThrowError(
      /invalid_canonical_value/,
    );
    expect(() => hashCanonicalJson({ bad: Number.NaN })).toThrowError(
      /invalid_canonical_value/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashCanonicalJson(cyclic)).toThrowError(
      /invalid_canonical_value/,
    );
  });

  it("hashes canonical artifact bytes", () => {
    expect(
      hashArtifact({
        schema_version: 1,
        kind: "command",
        name: "audit-code",
        description: "Audit code",
        prompt: "Audit.",
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
