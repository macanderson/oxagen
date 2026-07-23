import { readdirSync, readFileSync } from "node:fs";
import {
  budgetTokens,
  PROTOCOL_VERSION as SDK_PROTOCOL_VERSION,
} from "@contextgraphprotocol/typescript-sdk";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  CONTEXTGRAPH_FIXTURE_PROFILE_VERSION,
  CONTEXTGRAPH_PROTOCOL_VERSION,
  declaresHonestTokenCostV1,
  expectedInlineTokenCostV1,
  hasValidTemporalFieldsV1,
  invalidTemporalFieldsV1,
  isProtocolTimestampV1,
  normalizeContextFrameV1,
  normalizeContextQueryV1,
} from "./contextgraph.js";
import { digestJcs, jcsBytes, sha256Digest } from "./digest.js";

interface DigestCase {
  name: string;
  source: Record<string, unknown>;
  expected_normalized: Record<string, unknown>;
  expected_jcs_utf8: string;
  sha256: string;
}

interface StrictCase {
  name: string;
  target: "frame" | "query";
  input: Record<string, unknown>;
  unknown_path: string;
}

interface FixtureManifest {
  protocol_version: string;
  fixture_profile_version: string;
  generation_command: string;
  files: Record<string, string>;
  upstream_repository: string;
  upstream_commit: string;
  upstream_manifest_sha256: string;
}

const fixtureDirectory = new URL("../fixtures/contextgraph/", import.meta.url);

function readFixtureText(name: string): string {
  return readFileSync(new URL(name, fixtureDirectory), "utf8");
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function minimalFrame(overrides: Record<string, unknown> = {}) {
  return {
    id: "frame:test",
    kind: "fact",
    title: "Test frame",
    content: "Evidence content",
    score: 0.5,
    token_cost: 1,
    citation_label: "test fixture",
    ...overrides,
  };
}

function minimalQuery(overrides: Record<string, unknown> = {}) {
  return {
    goal: "Find relevant evidence",
    max_frames: 8,
    max_tokens: 2048,
    ...overrides,
  };
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

describe("locked Context Graph fixtures", () => {
  it("pins the upstream source, profile, exact file set, and file digests", () => {
    const manifest = readFixture<FixtureManifest>("manifest.json");
    const expectedFiles = [
      "context-frame.missing-citation.invalid.json",
      "context-frame.valid.json",
      "context-query.valid.json",
      "normalization-vectors.json",
      "strict-validation.invalid.json",
    ];

    expect(Object.keys(manifest).sort()).toEqual([
      "files",
      "fixture_profile_version",
      "generation_command",
      "protocol_version",
      "upstream_commit",
      "upstream_manifest_sha256",
      "upstream_repository",
    ]);
    expect(manifest.protocol_version).toBe(CONTEXTGRAPH_PROTOCOL_VERSION);
    expect(manifest.fixture_profile_version).toBe(
      CONTEXTGRAPH_FIXTURE_PROFILE_VERSION,
    );
    expect(manifest.generation_command).toBe(
      "cargo test -p contextgraph-conformance --test golden_fixtures",
    );
    expect(manifest.upstream_repository).toBe(
      "https://github.com/macanderson/context-graph-protocol",
    );
    expect(manifest.upstream_commit).toBe(
      "9fb559aa4d3ec4cf062e59dab113eae4e175c5fa",
    );
    expect(manifest.upstream_manifest_sha256).toBe(
      "sha256:bae644ace4444881450af4f69b3a89e4d2178cc60f4c3a5b7adb3350327d437a",
    );
    expect(Object.keys(manifest.files).sort()).toEqual(expectedFiles);
    expect(
      readdirSync(fixtureDirectory)
        .filter((name) => name !== "manifest.json")
        .sort(),
    ).toEqual(expectedFiles);

    for (const [name, digest] of Object.entries(manifest.files)) {
      const bytes = readFileSync(new URL(name, fixtureDirectory));
      expect(sha256Digest(bytes), name).toBe(digest);
    }
  });
});

describe("normalizeContextFrameV1", () => {
  it("matches every published normalized frame, JCS artifact, and digest", () => {
    const fixture = readFixture<{ cases: DigestCase[] }>(
      "context-frame.valid.json",
    );

    for (const fixtureCase of fixture.cases) {
      const source = deepFreeze(structuredClone(fixtureCase.source));
      const before = structuredClone(source);
      const normalized = normalizeContextFrameV1(source);

      expect(normalized, fixtureCase.name).toEqual(
        fixtureCase.expected_normalized,
      );
      expect(new TextDecoder().decode(jcsBytes(normalized))).toBe(
        fixtureCase.expected_jcs_utf8,
      );
      expect(digestJcs(normalized)).toBe(fixtureCase.sha256);
      expect(source).toEqual(before);
      expect(Object.isFrozen(source)).toBe(true);
    }
  });

  it("preserves provenance, relation, and embedding vector order", () => {
    const source = minimalFrame({
      provenance: [{ type: "first" }, { type: "second" }],
      embedding: { fingerprint: "embedding:v1", vector: [0.25, -1, 0.5] },
      relations: [
        { rel: "first", target_uri: "contextgraph://first" },
        { rel: "second", target_uri: "contextgraph://second" },
      ],
    });

    const normalized = normalizeContextFrameV1(source);

    expect(normalized.provenance.map(({ type }) => type)).toEqual([
      "first",
      "second",
    ]);
    expect(normalized.embedding?.vector).toEqual([0.25, -1, 0.5]);
    expect(normalized.relations.map(({ rel }) => rel)).toEqual([
      "first",
      "second",
    ]);
  });

  it.each(["snippet", "symbol", "fact", "doc", "memory", "episode", "graph"])(
    "accepts the current %s frame kind",
    (kind) => {
      expect(normalizeContextFrameV1(minimalFrame({ kind })).kind).toBe(kind);
    },
  );

  it.each(["unknown", "", "Snippet"])(
    "rejects unsupported frame kind %j",
    (kind) => {
      expect(() => normalizeContextFrameV1(minimalFrame({ kind }))).toThrow(
        ZodError,
      );
    },
  );

  it.each([-0.01, 1.01])("rejects finite out-of-range score %s", (score) => {
    expect(() => normalizeContextFrameV1(minimalFrame({ score }))).toThrow(
      ZodError,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-I-JSON score %s at the JSON-wire boundary",
    (score) => {
      expect(() => normalizeContextFrameV1(minimalFrame({ score }))).toThrow(
        TypeError,
      );
    },
  );

  it.each([-1, 1.5, 4_294_967_296])(
    "rejects invalid token cost %s",
    (tokenCost) => {
      expect(() =>
        normalizeContextFrameV1(minimalFrame({ token_cost: tokenCost })),
      ).toThrow(ZodError);
    },
  );

  it("rejects negative-zero token cost while accepting both u32 bounds", () => {
    expect(Object.is(-0, 0)).toBe(false);
    expect(() =>
      normalizeContextFrameV1(minimalFrame({ token_cost: -0 })),
    ).toThrow(ZodError);

    for (const tokenCost of [0, 4_294_967_295]) {
      const normalized = normalizeContextFrameV1(
        minimalFrame({ token_cost: tokenCost }),
      );
      expect(normalized.token_cost).toBe(tokenCost);
      expect(Object.is(normalized.token_cost, -0)).toBe(false);
    }
  });

  it.each([undefined, "", " \t\n"])(
    "rejects missing or blank citation label %j",
    (citationLabel) => {
      const frame = minimalFrame();
      if (citationLabel === undefined) {
        delete (frame as Partial<typeof frame>).citation_label;
      } else {
        frame.citation_label = citationLabel;
      }
      expect(() => normalizeContextFrameV1(frame)).toThrow(ZodError);
    },
  );

  it.each([
    "uri",
    "valid_from",
    "valid_to",
    "recorded_at",
    "provenance",
    "embedding",
    "relations",
  ])("rejects explicit null for %s", (field) => {
    expect(() =>
      normalizeContextFrameV1(minimalFrame({ [field]: null })),
    ).toThrow(ZodError);
  });

  it.each([
    ["provenance uri", { provenance: [{ type: "file", uri: null }] }],
    [
      "embedding vector",
      { embedding: { fingerprint: "embedding:v1", vector: null } },
    ],
    [
      "relation display name",
      {
        relations: [
          {
            rel: "related_to",
            target_uri: "contextgraph://target",
            display_name: null,
          },
        ],
      },
    ],
  ])("rejects explicit nested null for %s", (_label, overrides) => {
    expect(() => normalizeContextFrameV1(minimalFrame(overrides))).toThrow(
      ZodError,
    );
  });

  it.each([
    ["provenance type", { provenance: [{}] }],
    ["embedding fingerprint", { embedding: {} }],
    ["relation rel", { relations: [{ target_uri: "contextgraph://target" }] }],
    ["relation target_uri", { relations: [{ rel: "related_to" }] }],
  ])("rejects missing nested %s", (_label, overrides) => {
    expect(() => normalizeContextFrameV1(minimalFrame(overrides))).toThrow(
      ZodError,
    );
  });

  it("rejects non-finite frame embedding values", () => {
    expect(() =>
      normalizeContextFrameV1(
        minimalFrame({
          embedding: {
            fingerprint: "embedding:v1",
            vector: [Number.POSITIVE_INFINITY],
          },
        }),
      ),
    ).toThrow(TypeError);
  });

  it("accepts the finite f32 bounds without rounding source numbers", () => {
    const maxF32 = 3.4028234663852886e38;
    const sourceValue = 0.1;

    expect(Math.fround(maxF32)).toBe(maxF32);
    expect(
      normalizeContextFrameV1(
        minimalFrame({
          embedding: {
            fingerprint: "embedding:v1",
            vector: [maxF32, -maxF32, sourceValue],
          },
        }),
      ).embedding?.vector,
    ).toEqual([maxF32, -maxF32, sourceValue]);
  });

  it.each([3.4028236e38, -3.4028236e38])(
    "rejects frame embedding value %s when f32 conversion overflows",
    (value) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isFinite(Math.fround(value))).toBe(false);
      expect(() =>
        normalizeContextFrameV1(
          minimalFrame({
            embedding: { fingerprint: "embedding:v1", vector: [value] },
          }),
        ),
      ).toThrow(ZodError);
    },
  );

  it.each(["id", "kind", "title", "content", "score", "token_cost"])(
    "rejects a missing required %s field",
    (field) => {
      const frame = minimalFrame();
      delete frame[field as keyof typeof frame];
      expect(() => normalizeContextFrameV1(frame)).toThrow(ZodError);
    },
  );

  it("consumes both published missing-citation negatives", () => {
    const fixture = readFixture<{
      missing: Record<string, unknown>;
      blank: Record<string, unknown>;
    }>("context-frame.missing-citation.invalid.json");

    expect(() => normalizeContextFrameV1(fixture.missing)).toThrow(ZodError);
    expect(() => normalizeContextFrameV1(fixture.blank)).toThrow(ZodError);
  });
});

describe("normalizeContextQueryV1", () => {
  it("matches every published normalized query, JCS artifact, and digest", () => {
    const fixture = readFixture<{ cases: DigestCase[] }>(
      "context-query.valid.json",
    );

    for (const fixtureCase of fixture.cases) {
      const source = deepFreeze(structuredClone(fixtureCase.source));
      const before = structuredClone(source);
      const normalized = normalizeContextQueryV1(source);

      expect(normalized, fixtureCase.name).toEqual(
        fixtureCase.expected_normalized,
      );
      expect(new TextDecoder().decode(jcsBytes(normalized))).toBe(
        fixtureCase.expected_jcs_utf8,
      );
      expect(digestJcs(normalized)).toBe(fixtureCase.sha256);
      expect(source).toEqual(before);
      expect(Object.isFrozen(source)).toBe(true);
    }
  });

  it("preserves embedding, kinds, and anchors order", () => {
    const source = minimalQuery({
      query_text: "retry café",
      embedding: [0.75, -0.25, 1],
      kinds: ["doc", "snippet", "graph"],
      anchors: ["file:///second", "symbol:///first"],
      as_of: "2026-07-21T12:34:56Z",
    });

    const normalized = normalizeContextQueryV1(source);

    expect(normalized.embedding).toEqual([0.75, -0.25, 1]);
    expect(normalized.kinds).toEqual(["doc", "snippet", "graph"]);
    expect(normalized.anchors).toEqual(["file:///second", "symbol:///first"]);
  });

  it.each(["max_frames", "max_tokens"])(
    "enforces u32 bounds for %s",
    (field) => {
      for (const value of [-1, 1.5, 4_294_967_296]) {
        expect(() =>
          normalizeContextQueryV1(minimalQuery({ [field]: value })),
        ).toThrow(ZodError);
      }
      expect(
        normalizeContextQueryV1(minimalQuery({ [field]: 4_294_967_295 }))[
          field as "max_frames" | "max_tokens"
        ],
      ).toBe(4_294_967_295);
    },
  );

  it.each(["max_frames", "max_tokens"] as const)(
    "rejects negative zero for query %s while accepting positive zero",
    (field) => {
      expect(Object.is(-0, 0)).toBe(false);
      expect(() =>
        normalizeContextQueryV1(minimalQuery({ [field]: -0 })),
      ).toThrow(ZodError);

      const normalized = normalizeContextQueryV1(minimalQuery({ [field]: 0 }));
      expect(normalized[field]).toBe(0);
      expect(Object.is(normalized[field], -0)).toBe(false);
    },
  );

  it.each(["query_text", "embedding", "kinds", "anchors", "as_of"])(
    "rejects explicit null for %s",
    (field) => {
      expect(() =>
        normalizeContextQueryV1(minimalQuery({ [field]: null })),
      ).toThrow(ZodError);
    },
  );

  it("rejects non-finite query embedding values", () => {
    expect(() =>
      normalizeContextQueryV1(
        minimalQuery({ embedding: [Number.NEGATIVE_INFINITY] }),
      ),
    ).toThrow(TypeError);
  });

  it("accepts the finite f32 bounds without rounding source numbers", () => {
    const maxF32 = 3.4028234663852886e38;
    const sourceValue = 0.1;

    expect(Math.fround(maxF32)).toBe(maxF32);
    expect(
      normalizeContextQueryV1(
        minimalQuery({ embedding: [maxF32, -maxF32, sourceValue] }),
      ).embedding,
    ).toEqual([maxF32, -maxF32, sourceValue]);
  });

  it.each([3.4028236e38, -3.4028236e38])(
    "rejects query embedding value %s when f32 conversion overflows",
    (value) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isFinite(Math.fround(value))).toBe(false);
      expect(() =>
        normalizeContextQueryV1(minimalQuery({ embedding: [value] })),
      ).toThrow(ZodError);
    },
  );

  it.each(["goal", "max_frames", "max_tokens"])(
    "rejects a missing required %s field",
    (field) => {
      const query = minimalQuery();
      delete query[field as keyof typeof query];
      expect(() => normalizeContextQueryV1(query)).toThrow(ZodError);
    },
  );
});

describe("JSON-wire normalization boundary", () => {
  it("rejects Object.prototype accessors before Zod can alter required fields", () => {
    const frame = minimalFrame();
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "id");
    let getterCalls = 0;
    let setterCalls = 0;
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Object.prototype, "id", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "polluted:id";
      },
      set: () => {
        setterCalls += 1;
      },
    });

    try {
      normalized = normalizeContextFrameV1(frame);
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Object.prototype, "id", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
  });

  it("rejects String.prototype trim changes before citation validation", () => {
    const previous = Object.getOwnPropertyDescriptor(String.prototype, "trim");
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(String.prototype, "trim", {
      configurable: true,
      value: () => "polluted nonblank citation",
    });

    try {
      normalized = normalizeContextFrameV1(
        minimalFrame({ citation_label: " \t\n" }),
      );
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(String.prototype, "trim", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects Set.prototype membership changes before enum validation", () => {
    const previous = Object.getOwnPropertyDescriptor(Set.prototype, "has");
    if (previous === undefined || !("value" in previous)) {
      throw new Error("Set.prototype.has data descriptor is unavailable");
    }
    const nativeHas = previous.value as Set<unknown>["has"];
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Set.prototype, "has", {
      configurable: true,
      value: function (this: Set<unknown>, candidate: unknown) {
        if (this.size === 7) {
          return true;
        }
        return Reflect.apply(nativeHas, this, [candidate]) as boolean;
      },
    });

    try {
      normalized = normalizeContextFrameV1(
        minimalFrame({ kind: "NOT_A_KIND" }),
      );
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Set.prototype, "has", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects removed prototype descriptors and permits exact restoration", () => {
    const previous = Object.getOwnPropertyDescriptor(
      String.prototype,
      "padEnd",
    );
    if (previous === undefined) {
      throw new Error("String.prototype.padEnd descriptor is unavailable");
    }
    let normalized: unknown;
    let error: unknown;
    Reflect.deleteProperty(String.prototype, "padEnd");

    try {
      normalized = normalizeContextQueryV1(minimalQuery());
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(String.prototype, "padEnd", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
    expect(normalizeContextQueryV1(minimalQuery()).goal).toBe(
      "Find relevant evidence",
    );
  });

  it("rejects an empty inherited array iterator before Zod can skip frame fields", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      value: () => ({
        next: () => ({ done: true, value: undefined }),
      }),
    });

    try {
      normalized = normalizeContextFrameV1(minimalFrame());
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, Symbol.iterator, previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects inherited map pollution before Zod can erase an invalid vector", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, "map", {
      configurable: true,
      value: () => [],
    });

    try {
      normalized = normalizeContextQueryV1(
        minimalQuery({ embedding: [3.4028236e38] }),
      );
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, "map", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects unrelated Array.prototype changes through the full integrity guard", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "filter");
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, "filter", {
      configurable: true,
      value: () => [],
    });

    try {
      normalized = normalizeContextQueryV1(minimalQuery());
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, "filter", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects added Array.prototype properties through the full integrity guard", () => {
    const key = "__runEvidencePollutionTest__";
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, key, {
      configurable: true,
      value: true,
    });

    try {
      normalized = normalizeContextFrameV1(minimalFrame());
    } catch (caught) {
      error = caught;
    } finally {
      Reflect.deleteProperty(Array.prototype, key);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects changed Array.prototype descriptor flags", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "forEach",
    );
    if (previous === undefined) {
      throw new Error("Array.prototype.forEach descriptor is unavailable");
    }
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, "forEach", {
      ...previous,
      enumerable: !previous.enumerable,
    });

    try {
      normalized = normalizeContextQueryV1(minimalQuery());
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, "forEach", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
  });

  it("rejects data-to-accessor Array.prototype changes without invoking getters", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "slice");
    if (previous === undefined || !("value" in previous)) {
      throw new Error("Array.prototype.slice data descriptor is unavailable");
    }
    let getterCalls = 0;
    let normalized: unknown;
    let error: unknown;
    Object.defineProperty(Array.prototype, "slice", {
      configurable: previous.configurable,
      enumerable: previous.enumerable,
      get: () => {
        getterCalls += 1;
        return previous.value;
      },
    });

    try {
      normalized = normalizeContextQueryV1(minimalQuery());
    } catch (caught) {
      error = caught;
    } finally {
      restoreOwnProperty(Array.prototype, "slice", previous);
    }

    expect(normalized).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
    expect(getterCalls).toBe(0);
  });

  it("does not accept an inherited citation label", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "citation_label",
    );
    Object.defineProperty(Object.prototype, "citation_label", {
      configurable: true,
      value: "polluted citation",
    });
    const frame = minimalFrame();
    delete (frame as Partial<typeof frame>).citation_label;

    try {
      expect(() => normalizeContextFrameV1(frame)).toThrow();
    } finally {
      restoreOwnProperty(Object.prototype, "citation_label", previous);
    }
  });

  it("does not accept inherited required query fields", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "goal");
    Object.defineProperty(Object.prototype, "goal", {
      configurable: true,
      value: "polluted goal",
    });

    try {
      expect(() =>
        normalizeContextQueryV1({ max_frames: 8, max_tokens: 2048 }),
      ).toThrow();
    } finally {
      restoreOwnProperty(Object.prototype, "goal", previous);
    }
  });

  it("rejects class instances", () => {
    class FrameInput {}
    const frame = Object.assign(new FrameInput(), minimalFrame());

    expect(() => normalizeContextFrameV1(frame)).toThrow(TypeError);
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const frame = Object.defineProperty(minimalFrame(), "content", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "getter content";
      },
    });

    expect(() => normalizeContextFrameV1(frame)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol and explicit undefined fields recursively", () => {
    const provenanceWithSymbol = {
      type: "file",
      [Symbol("hidden")]: true,
    };

    expect(() =>
      normalizeContextFrameV1(
        minimalFrame({ provenance: [provenanceWithSymbol] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      normalizeContextFrameV1(
        minimalFrame({ provenance: [{ type: "file", uri: undefined }] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      normalizeContextQueryV1(minimalQuery({ query_text: undefined })),
    ).toThrow(TypeError);
  });

  it("rejects unpaired surrogates recursively", () => {
    expect(() =>
      normalizeContextFrameV1(
        minimalFrame({ provenance: [{ type: "file", uri: "\ud800" }] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      normalizeContextQueryV1(minimalQuery({ anchors: ["\udc00"] })),
    ).toThrow(TypeError);
  });

  it("rejects nested Proxies without invoking their traps", () => {
    let trapCalls = 0;
    const provenance = new Proxy(
      { type: "file" },
      {
        getPrototypeOf: (target) => {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );

    expect(() =>
      normalizeContextFrameV1(minimalFrame({ provenance: [provenance] })),
    ).toThrow(TypeError);
    expect(trapCalls).toBe(0);
  });

  it("rejects root query Proxies without invoking their traps", () => {
    let trapCalls = 0;
    const query = new Proxy(minimalQuery(), {
      getPrototypeOf: (target) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get: (target, key, receiver) => {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    expect(() => normalizeContextQueryV1(query)).toThrow(TypeError);
    expect(trapCalls).toBe(0);
  });
});

function referenceFrame(overrides: Record<string, unknown> = {}) {
  const base = minimalFrame({
    representation: "reference",
    content_ref: {
      provider_id: "provider:test",
      uri: "contextgraph://content/1",
    },
    canonical_content_hash: `sha256:${"a".repeat(64)}`,
    token_cost: 0,
  });
  delete (base as Partial<typeof base>).content;
  return { ...base, ...overrides };
}

function compactFrame(overrides: Record<string, unknown> = {}) {
  return minimalFrame({
    representation: "compact",
    content: "Summarized evidence",
    content_digest: `sha256:${"b".repeat(64)}`,
    canonical_content_hash: `sha256:${"c".repeat(64)}`,
    transform: {
      method: "summary",
      implementation: "test-summarizer",
      version: "1.0.0",
    },
    content_ref: {
      provider_id: "provider:test",
      uri: "contextgraph://content/2",
    },
    token_cost: 5,
    ...overrides,
  });
}

describe("#33 frame representations", () => {
  it("accepts a reference frame and keeps content absent", () => {
    const normalized = normalizeContextFrameV1(referenceFrame());

    expect(normalized.representation).toBe("reference");
    expect("content" in normalized).toBe(false);
    expect(normalized.content_ref).toEqual({
      provider_id: "provider:test",
      uri: "contextgraph://content/1",
    });
  });

  it("accepts a fully populated compact frame", () => {
    const normalized = normalizeContextFrameV1(compactFrame());

    expect(normalized.representation).toBe("compact");
    expect(normalized.transform?.method).toBe("summary");
  });

  it("accepts an explicit full representation without materializing a default", () => {
    expect(
      normalizeContextFrameV1(minimalFrame({ representation: "full" }))
        .representation,
    ).toBe("full");
    expect("representation" in normalizeContextFrameV1(minimalFrame())).toBe(
      false,
    );
  });

  it("treats a frame without representation as full: content is required", () => {
    const frame = minimalFrame();
    delete (frame as Partial<typeof frame>).content;

    expect(() => normalizeContextFrameV1(frame)).toThrow(
      /full frame requires inline content/,
    );
  });

  it.each([
    ["inline content", { content: "" }],
    ["an inline content hash", { content_digest: `sha256:${"d".repeat(64)}` }],
    [
      "a transform",
      {
        transform: {
          method: "summary",
          implementation: "test-summarizer",
          version: "1.0.0",
        },
      },
    ],
  ])("rejects a reference frame carrying %s", (_label, overrides) => {
    expect(() => normalizeContextFrameV1(referenceFrame(overrides))).toThrow(
      ZodError,
    );
  });

  it.each(["content_ref", "canonical_content_hash"])(
    "rejects a reference frame missing %s",
    (field) => {
      const frame = referenceFrame();
      delete (frame as Record<string, unknown>)[field];
      expect(() => normalizeContextFrameV1(frame)).toThrow(ZodError);
    },
  );

  it.each([
    "content",
    "content_digest",
    "canonical_content_hash",
    "transform",
    "content_ref",
  ])("rejects a compact frame missing %s", (field) => {
    const frame = compactFrame();
    delete (frame as Record<string, unknown>)[field];
    expect(() => normalizeContextFrameV1(frame)).toThrow(ZodError);
  });

  it.each([
    ["representation", "Full"],
    ["representation", "unknown"],
    ["representation", ""],
    ["content_fidelity", "Exact"],
    ["minimum_content_fidelity", "verbatim"],
    ["inline_content_requirement", "maybe"],
  ])("rejects unsupported %s value %j", (field, value) => {
    expect(() =>
      normalizeContextFrameV1(minimalFrame({ [field]: value })),
    ).toThrow(ZodError);
  });

  it.each([
    "content",
    "content_digest",
    "representation",
    "content_fidelity",
    "canonical_content_hash",
    "content_ref",
    "transform",
    "minimum_content_fidelity",
    "inline_content_requirement",
    "canonical_token_cost",
    "tokenizer_ref",
  ])("rejects explicit null for %s", (field) => {
    expect(() =>
      normalizeContextFrameV1(minimalFrame({ [field]: null })),
    ).toThrow(ZodError);
  });

  it.each([
    ["content_ref", { provider_id: "provider:test" }],
    ["content_ref", { uri: "contextgraph://content/1" }],
    ["transform", { method: "summary", implementation: "test-summarizer" }],
    ["transform", { method: "summary", version: "1.0.0" }],
  ])("rejects %s missing a required field: %j", (field, value) => {
    expect(() =>
      normalizeContextFrameV1(referenceFrame({ [field]: value })),
    ).toThrow(ZodError);
  });

  it.each([
    [
      "content_ref",
      {
        provider_id: "provider:test",
        uri: "contextgraph://content/1",
        extra: true,
      },
    ],
    [
      "transform",
      {
        method: "summary",
        implementation: "test-summarizer",
        version: "1.0.0",
        extra: true,
      },
    ],
  ])("rejects unknown keys nested in %s", (field, value) => {
    expect(() =>
      normalizeContextFrameV1(compactFrame({ [field]: value })),
    ).toThrow(ZodError);
  });

  it("enforces u32 bounds for canonical_token_cost", () => {
    for (const value of [-1, 1.5, 4_294_967_296]) {
      expect(() =>
        normalizeContextFrameV1(minimalFrame({ canonical_token_cost: value })),
      ).toThrow(ZodError);
    }
    expect(
      normalizeContextFrameV1(
        minimalFrame({ canonical_token_cost: 4_294_967_295 }),
      ).canonical_token_cost,
    ).toBe(4_294_967_295);
  });

  it("round-trips the fidelity and tokenizer surface", () => {
    const normalized = normalizeContextFrameV1(
      minimalFrame({
        content_fidelity: "summarized",
        minimum_content_fidelity: "exact",
        inline_content_requirement: "resolvable_reference_allowed",
        canonical_token_cost: 128,
        tokenizer_ref: "tokenizer:test/1",
      }),
    );

    expect(normalized.content_fidelity).toBe("summarized");
    expect(normalized.minimum_content_fidelity).toBe("exact");
    expect(normalized.inline_content_requirement).toBe(
      "resolvable_reference_allowed",
    );
    expect(normalized.canonical_token_cost).toBe(128);
    expect(normalized.tokenizer_ref).toBe("tokenizer:test/1");
  });

  it("round-trips query representation preferences in order", () => {
    const normalized = normalizeContextQueryV1(
      minimalQuery({ representation_preferences: ["reference", "full"] }),
    );

    expect(normalized.representation_preferences).toEqual([
      "reference",
      "full",
    ]);
    expect(
      "representation_preferences" in normalizeContextQueryV1(minimalQuery()),
    ).toBe(false);
  });

  it.each([null, ["Full"], ["unknown"]])(
    "rejects invalid query representation preferences %j",
    (value) => {
      expect(() =>
        normalizeContextQueryV1(
          minimalQuery({ representation_preferences: value }),
        ),
      ).toThrow(ZodError);
    },
  );
});

describe("canonical token accounting (§B3)", () => {
  it("derives the expected cost from the canonical SDK arithmetic", () => {
    expect(expectedInlineTokenCostV1({ content: "Evidence content" })).toBe(4);
    expect(expectedInlineTokenCostV1({ content: "Evidence content" })).toBe(
      budgetTokens("Evidence content"),
    );
    // Multi-byte UTF-8 counts bytes, not characters: "café" is 5 bytes.
    expect(expectedInlineTokenCostV1({ content: "café" })).toBe(2);
    expect(expectedInlineTokenCostV1({ content: undefined })).toBe(0);
  });

  it("judges token-cost honesty against the frame's inline content", () => {
    expect(
      declaresHonestTokenCostV1({ content: "Evidence content", token_cost: 4 }),
    ).toBe(true);
    expect(
      declaresHonestTokenCostV1({ content: "Evidence content", token_cost: 1 }),
    ).toBe(false);
    expect(
      declaresHonestTokenCostV1({ content: undefined, token_cost: 0 }),
    ).toBe(true);
  });

  it("keeps honesty a conformance predicate, not a parse gate", () => {
    // The pinned golden fixtures predate #33's honesty rule, so a dishonest
    // cost still parses — and is caught by the predicate.
    const normalized = normalizeContextFrameV1(
      minimalFrame({ token_cost: 999 }),
    );
    expect(declaresHonestTokenCostV1(normalized)).toBe(false);
  });
});

describe("temporal profile (§F4)", () => {
  it.each([
    "2026-07-20T18:00:00Z",
    "2026-07-20T18:00:00.123Z",
    "2026-07-20T18:00:60Z",
    "2024-02-29T00:00:00Z",
  ])("accepts protocol timestamp %s", (value) => {
    expect(isProtocolTimestampV1(value)).toBe(true);
  });

  it.each([
    "2026-07-20T18:00:00+02:00",
    "last tuesday",
    "2026-02-29T00:00:00Z",
    "2026-07-20T18:00:00.Z",
    "2026-07-20T18:00:00",
    "2026-13-01T00:00:00Z",
    "2026-07-20T18:00:00z",
    "2026-07-20t18:00:00Z",
  ])("rejects non-protocol timestamp %j", (value) => {
    expect(isProtocolTimestampV1(value)).toBe(false);
  });

  it("names the temporal fields outside the profile", () => {
    const frame = normalizeContextFrameV1(
      minimalFrame({
        valid_from: "2026-07-20T18:00:00+02:00",
        recorded_at: "2026-07-20T18:00:00Z",
      }),
    );

    expect(invalidTemporalFieldsV1(frame)).toEqual(["valid_from"]);
    expect(hasValidTemporalFieldsV1(frame)).toBe(false);
    expect(
      hasValidTemporalFieldsV1(normalizeContextFrameV1(minimalFrame())),
    ).toBe(true);
  });
});

describe("SDK anchoring", () => {
  it("pins the fixture protocol version to the SDK's protocol version", () => {
    const manifest = readFixture<FixtureManifest>("manifest.json");

    expect(CONTEXTGRAPH_PROTOCOL_VERSION).toBe(SDK_PROTOCOL_VERSION);
    expect(manifest.protocol_version).toBe(SDK_PROTOCOL_VERSION);
  });
});

describe("strict current-CGP profile", () => {
  it("rejects every published unknown key at its declared path", () => {
    const fixture = readFixture<{ cases: StrictCase[] }>(
      "strict-validation.invalid.json",
    );

    expect(fixture.cases.map(({ name }) => name).sort()).toEqual([
      "frame_embedding_unknown",
      "frame_provenance_unknown",
      "frame_relation_unknown",
      "frame_top_level_unknown",
      "query_top_level_unknown",
    ]);

    for (const fixtureCase of fixture.cases) {
      const normalize =
        fixtureCase.target === "frame"
          ? normalizeContextFrameV1
          : normalizeContextQueryV1;
      let error: unknown;
      try {
        normalize(fixtureCase.input);
      } catch (caught) {
        error = caught;
      }

      expect(error, fixtureCase.name).toBeInstanceOf(ZodError);
      const zodError = error as ZodError;
      const issue = zodError.issues.find(
        (candidate) => candidate.code === "unrecognized_keys",
      );
      expect(issue, fixtureCase.name).toBeDefined();
      if (issue?.code === "unrecognized_keys") {
        const path = [fixtureCase.target, ...issue.path, issue.keys[0]].join(
          ".",
        );
        expect(path.replace(/\.(\d+)\./g, "[$1].")).toBe(
          fixtureCase.unknown_path,
        );
      }
    }
  });
});
