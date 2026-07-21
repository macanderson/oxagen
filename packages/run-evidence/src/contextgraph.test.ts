import { readdirSync, readFileSync } from "node:fs";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  CONTEXTGRAPH_FIXTURE_PROFILE_VERSION,
  CONTEXTGRAPH_PROTOCOL_VERSION,
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
      "36a64488f0fe300597ab494e1c4f9e94778175a0",
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
