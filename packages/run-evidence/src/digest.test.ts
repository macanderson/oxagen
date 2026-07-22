import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { assertDigest, digestJcs, jcsBytes, sha256Digest } from "./digest.js";

interface DigestCase {
  name: string;
  expected_normalized: unknown;
  expected_jcs_utf8: string;
  sha256: string;
}

interface NormalizationVector extends DigestCase {
  input_json: string;
}

function readFixture<T>(name: string): T {
  const url = new URL(`../fixtures/contextgraph/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function expectDigestCase(value: unknown, fixture: DigestCase): void {
  const expectedBytes = new TextEncoder().encode(fixture.expected_jcs_utf8);

  expect(jcsBytes(value)).toEqual(expectedBytes);
  expect(sha256Digest(expectedBytes)).toBe(fixture.sha256);
  expect(digestJcs(value)).toBe(fixture.sha256);
  expect(assertDigest(fixture.sha256)).toBe(fixture.sha256);
}

function restoreOwnProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}

describe("JCS digest fixtures", () => {
  it("matches every upstream generic RFC 8785 vector exactly", () => {
    const fixture = readFixture<{ vectors: NormalizationVector[] }>(
      "normalization-vectors.json",
    );

    expect(fixture.vectors.map(({ name }) => name).sort()).toEqual([
      "escaping",
      "number_boundaries",
      "numbers",
      "unicode",
    ]);

    for (const vector of fixture.vectors) {
      const value: unknown = JSON.parse(vector.input_json);
      expect(value).toEqual(vector.expected_normalized);
      expectDigestCase(value, vector);
    }
  });

  it("matches the full and minimal frame artifacts exactly", () => {
    const fixture = readFixture<{ cases: DigestCase[] }>(
      "context-frame.valid.json",
    );

    expect(fixture.cases.map(({ name }) => name)).toEqual([
      "fully_populated_frame",
      "minimal_frame",
    ]);
    for (const fixtureCase of fixture.cases) {
      expectDigestCase(fixtureCase.expected_normalized, fixtureCase);
    }
  });

  it("matches the minimal query artifact exactly", () => {
    const fixture = readFixture<{ cases: DigestCase[] }>(
      "context-query.valid.json",
    );

    expect(fixture.cases).toHaveLength(1);
    expect(fixture.cases[0]?.name).toBe("minimal_query");
    expectDigestCase(
      fixture.cases[0]?.expected_normalized,
      fixture.cases[0] as DigestCase,
    );
  });
});

describe("jcsBytes", () => {
  it("uses exact UTF-8 bytes and UTF-16 property ordering", () => {
    const value = { "\u{1f600}": "grinning", "\ufb33": "dalet" };
    const expected = '{"😀":"grinning","דּ":"dalet"}';

    expect(jcsBytes(value)).toEqual(new TextEncoder().encode(expected));
  });

  it("treats an own non-function toJSON property as ordinary JSON data", () => {
    const value = { z: 3, toJSON: "data", a: 1 };

    expect(new TextDecoder().decode(jcsBytes(value))).toBe(
      '{"a":1,"toJSON":"data","z":3}',
    );
  });

  it("rejects lone surrogates after public charCodeAt mutation", () => {
    const previous = Object.getOwnPropertyDescriptor(
      String.prototype,
      "charCodeAt",
    );
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(String.prototype, "charCodeAt", {
      configurable: true,
      value: () => 0,
    });

    try {
      result = jcsBytes("\ud800");
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(String.prototype, "charCodeAt", previous);
    }

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("uses captured TextEncoder.encode for canonical bytes", () => {
    const previous = Object.getOwnPropertyDescriptor(
      TextEncoder.prototype,
      "encode",
    );
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(TextEncoder.prototype, "encode", {
      configurable: true,
      value: () => Uint8Array.of(0),
    });

    try {
      result = jcsBytes({ a: 1 });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(TextEncoder.prototype, "encode", previous);
    }

    expect(error).toBeUndefined();
    expect(result).toEqual(new Uint8Array([123, 34, 97, 34, 58, 49, 125]));
  });

  it("uses the TextEncoder constructor captured at module initialization", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: class PollutedTextEncoder {
        constructor() {
          throw new Error("polluted TextEncoder was constructed");
        }
      },
    });

    try {
      result = jcsBytes({ a: 1 });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(globalThis, "TextEncoder", previous);
    }

    expect(error).toBeUndefined();
    expect(result).toEqual(new Uint8Array([123, 34, 97, 34, 58, 49, 125]));
  });

  it("ignores ambient Object.prototype pollution", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => ({ polluted: true }),
    });

    try {
      expect(new TextDecoder().decode(jcsBytes({ z: 2, a: 1 }))).toBe(
        '{"a":1,"z":2}',
      );
    } finally {
      restoreOwnProperty(Object.prototype, "toJSON", previous);
    }
  });

  it("ignores ambient Array.prototype pollution", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: () => ["polluted"],
    });

    try {
      expect(new TextDecoder().decode(jcsBytes([1, 2]))).toBe("[1,2]");
    } finally {
      restoreOwnProperty(Array.prototype, "toJSON", previous);
    }
  });

  it("does not consult the inherited array iterator", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("polluted array iterator was invoked");
      },
    });

    try {
      result = jcsBytes({ values: [1, 2] });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, Symbol.iterator, previous);
    }

    expect(error).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe('{"values":[1,2]}');
  });

  it("does not consult an inherited array reduce implementation", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "reduce");
    Object.defineProperty(Array.prototype, "reduce", {
      configurable: true,
      value: () => "polluted",
    });

    try {
      expect(new TextDecoder().decode(jcsBytes([1, 2]))).toBe("[1,2]");
    } finally {
      restoreOwnProperty(Array.prototype, "reduce", previous);
    }
  });

  it("does not consult a polluted Array.prototype.sort", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(Array.prototype, "sort", {
      configurable: true,
      value: () => {
        throw new Error("polluted array sort was invoked");
      },
    });

    try {
      result = jcsBytes({ z: 2, a: 1 });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, "sort", previous);
    }

    expect(error).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe('{"a":1,"z":2}');
  });

  it("rejects extra array properties despite conditional Set.has pollution", () => {
    const previous = Object.getOwnPropertyDescriptor(Set.prototype, "has");
    if (previous === undefined || !("value" in previous)) {
      throw new Error("Set.prototype.has data descriptor is unavailable");
    }
    const nativeHas = previous.value as Set<unknown>["has"];
    const value = Object.defineProperty([1], "extra", {
      enumerable: true,
      value: true,
    });
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(Set.prototype, "has", {
      configurable: true,
      value: function (this: Set<unknown>, candidate: unknown) {
        return typeof candidate === "string"
          ? true
          : (Reflect.apply(nativeHas, this, [candidate]) as boolean);
      },
    });

    try {
      result = jcsBytes(value);
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Set.prototype, "has", previous);
    }

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("uses captured Set.add when the public prototype method changes", () => {
    const previous = Object.getOwnPropertyDescriptor(Set.prototype, "add");
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(Set.prototype, "add", {
      configurable: true,
      value: () => {
        throw new Error("polluted Set.add was invoked");
      },
    });

    try {
      result = jcsBytes({ value: true });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Set.prototype, "add", previous);
    }

    expect(error).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe('{"value":true}');
  });

  it("uses captured Set.delete so shared references do not become cycles", () => {
    const previous = Object.getOwnPropertyDescriptor(Set.prototype, "delete");
    const shared = { value: true };
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(Set.prototype, "delete", {
      configurable: true,
      value: () => false,
    });

    try {
      result = jcsBytes({ left: shared, right: shared });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Set.prototype, "delete", previous);
    }

    expect(error).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe(
      '{"left":{"value":true},"right":{"value":true}}',
    );
  });

  it("uses the Set constructor captured at module initialization", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Set");
    let result: Uint8Array | undefined;
    let error: unknown;
    Object.defineProperty(globalThis, "Set", {
      configurable: true,
      value: class PollutedSet {
        constructor() {
          throw new Error("polluted global Set was constructed");
        }
      },
    });

    try {
      result = jcsBytes({ value: true });
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(globalThis, "Set", previous);
    }

    expect(error).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe('{"value":true}');
  });

  it("canonicalizes 20,000 descending keys without quadratic amplification", () => {
    const value: Record<string, number> = {};
    for (let index = 19_999; index >= 0; index -= 1) {
      value[`k${index.toString().padStart(5, "0")}`] = 0;
    }

    const startedAt = performance.now();
    const bytes = jcsBytes(value);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(bytes.byteLength).toBeGreaterThan(200_000);
    expect(elapsedMilliseconds).toBeLessThan(2_000);
  });

  it("rejects arrays with custom prototypes", () => {
    const value = [1, 2];
    Object.setPrototypeOf(value, Object.create(Array.prototype));

    expect(() => jcsBytes(value)).toThrow(TypeError);
  });

  it("rejects a Proxy before descriptor and get traps can disagree", () => {
    let trapCalls = 0;
    const value = new Proxy(
      { value: "descriptor value" },
      {
        getPrototypeOf: () => {
          trapCalls += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          trapCalls += 1;
          return ["value"];
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          return {
            configurable: true,
            enumerable: true,
            value: "descriptor value",
            writable: true,
          };
        },
        get: () => {
          trapCalls += 1;
          return "different get value";
        },
      },
    );

    expect(() => jcsBytes(value)).toThrow(TypeError);
    expect(trapCalls).toBe(0);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("unsupported")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["undefined property", { value: undefined }],
    ["function property", { value: () => undefined }],
    ["symbol property", { value: Symbol("unsupported") }],
    ["bigint property", { value: 1n }],
    ["undefined array entry", [undefined]],
    ["function array entry", [() => undefined]],
    ["symbol array entry", [Symbol("unsupported")]],
    ["bigint array entry", [1n]],
    ["non-plain Date", new Date("2026-07-21T00:00:00Z")],
    ["non-plain Map", new Map([["key", "value"]])],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate key", { "\udc00": true }],
  ])("rejects unsupported %s values", (_label, value) => {
    expect(() => jcsBytes(value)).toThrow(TypeError);
  });

  it("rejects sparse arrays", () => {
    const sparse = Array.from({ length: 2 });
    delete sparse[0];

    expect(() => jcsBytes(sparse)).toThrow(TypeError);
  });

  it("rejects cycles", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => jcsBytes(cyclic)).toThrow(TypeError);
  });

  it("rejects accessors rather than invoking them", () => {
    const value = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get: () => "value",
    });

    expect(() => jcsBytes(value)).toThrow(TypeError);
  });

  it("rejects array accessors rather than invoking them", () => {
    const value = Object.defineProperty([], 0, {
      enumerable: true,
      get: () => "value",
    });

    expect(() => jcsBytes(value)).toThrow(TypeError);
  });
});

describe("SHA-256 digest validation", () => {
  it("hashes only the exact bytes supplied", () => {
    expect(sha256Digest(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses captured Hash update and digest operations", () => {
    const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
    const previousUpdate = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "update",
    );
    const previousDigest = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "digest",
    );
    let result: string | undefined;
    let error: unknown;
    Object.defineProperty(hashPrototype, "update", {
      configurable: true,
      value: function (this: unknown) {
        return this;
      },
    });
    Object.defineProperty(hashPrototype, "digest", {
      configurable: true,
      value: () => "0".repeat(64),
    });

    try {
      result = sha256Digest(new TextEncoder().encode("abc"));
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(hashPrototype, "update", previousUpdate);
      restoreOwnProperty(hashPrototype, "digest", previousDigest);
    }

    expect(error).toBeUndefined();
    expect(result).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects malformed digests after public RegExp.test mutation", () => {
    const previous = Object.getOwnPropertyDescriptor(RegExp.prototype, "test");
    let result: string | undefined;
    let error: unknown;
    Object.defineProperty(RegExp.prototype, "test", {
      configurable: true,
      value: () => true,
    });

    try {
      result = assertDigest("not-a-digest");
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(RegExp.prototype, "test", previous);
    }

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it.each([
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha256:BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    "sha256:ba7816BF8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    " sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n",
    "sha512:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015a",
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015add",
  ])("rejects a non-canonical digest: %s", (digest) => {
    expect(() => assertDigest(digest)).toThrow(TypeError);
  });
});
