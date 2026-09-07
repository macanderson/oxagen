/**
 * Unit coverage for run-spec-v2.ts — the trusted admission contract
 * (docs/specs/run-evidence-ingress/spec.md "Trusted run and attempt identity";
 * 02-run-attempt-foundation-plan.md Task 1).
 *
 * These tests are the security boundary's specification, written before the
 * schema. The valuable assertions here are the REJECTIONS: a spec that parses
 * is admitted to a governed run, so every field that could be forged, left
 * unpinned, or confused between an internal UUID and a public id gets an
 * explicit negative case. Table-driven mutations of one known-good fixture
 * keep those cases valid — a fixture that stopped passing would fail the
 * happy-path test first, so a green negative case can never be green for the
 * wrong reason.
 */
import { describe, it, expect } from "vitest";
import {
  // digest + canonicalization primitives
  canonicalJson,
  digestOfCanonicalJson,
  assertSha256Digest,
  assertDecimalGeneration,
  // public id registry
  RESERVED_PUBLIC_ID_PREFIXES,
  // parsers / builders
  parseRunSpecV2,
  parseCallerRunInfluence,
  buildTrustedRunSpecV2,
  runSpecV2Digest,
  assertRunSpecV2Digest,
  compareRunRowIdentity,
  assertRunRowMatchesSpec,
  TRUSTED_RUN_SPEC_SECTIONS,
  type RunSpecV2,
  type RunRowIdentity,
  type CallerRunInfluence,
  type TrustedRunSpecV2Input,
} from "./run-spec-v2";
import {
  CanonicalJsonError,
  RunSpecValidationError,
  RunSpecDigestMismatchError,
  RunSpecIdentityMismatchError,
  UntrustedRunSpecFieldError,
  isRunSpecValidationError,
  isUntrustedRunSpecFieldError,
  isRunSpecDigestMismatchError,
  isRunSpecIdentityMismatchError,
} from "./run-errors";

// ── Fixtures ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const UUID_INITIATING = "11111111-1111-4111-8111-111111111111";
const UUID_AGENT_PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const UUID_AGENT = "33333333-3333-4333-8333-333333333333";
const UUID_AGENT_VERSION = "44444444-4444-4444-8444-444444444444";
const UUID_SNAPSHOT = "55555555-5555-4555-8555-555555555555";
const UUID_CONNECTION = "66666666-6666-4666-8666-666666666666";
const UUID_ENVIRONMENT = "77777777-7777-4777-8777-777777777777";
const UUID_PARENT_RUN = "88888888-8888-4888-8888-888888888888";
/** Carries hex letters, so upper/lower case is actually distinguishable. */
const UUID_MIXED_CASE = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";

const DIGEST_CHECKSUM = `sha256:${"a".repeat(64)}`;
const DIGEST_SNAPSHOT = `sha256:${"b".repeat(64)}`;
const DIGEST_CEILING = `sha256:${"c".repeat(64)}`;
const DIGEST_RETENTION = `sha256:${"d".repeat(64)}`;

const REPOSITORY_BINDING_PUBLIC_ID = `rpb_${"0".repeat(22)}`;
const RETENTION_POLICY_PUBLIC_ID = `rtn_${"1".repeat(22)}`;
const BASE_COMMIT_SHA = "e".repeat(40);
const BASE_TREE_SHA = "f".repeat(40);

/** A fully-pinned repo_edit spec — the shape admission must accept. */
function repoEditRaw(): Json {
  return {
    version: 2,
    run_kind: "repo_edit",
    goal: "Add a retry to the webhook publisher",
    engine_policy: {
      requested_engine: "stella",
      allowed_engine_versions: ["2.1.0", "2.2.0-rc.1"],
      model_policy_ref: "model-policy:default",
      max_steps: 64,
      max_attempts: 3,
    },
    actor_binding: {
      initiating_principal_id: UUID_INITIATING,
      agent_principal_id: UUID_AGENT_PRINCIPAL,
      agent_id: UUID_AGENT,
      agent_version_id: UUID_AGENT_VERSION,
      agent_version_checksum: DIGEST_CHECKSUM,
    },
    authorization_snapshot_ref: {
      snapshot_id: UUID_SNAPSHOT,
      snapshot_digest: DIGEST_SNAPSHOT,
      grant_ceiling_digest: DIGEST_CEILING,
      deny_generation_at_admission: { org: "12", workspace: "0" },
      resolved_at: "2026-07-21T10:00:00.000Z",
    },
    repository_binding: {
      repository_binding_public_id: REPOSITORY_BINDING_PUBLIC_ID,
      provider: "github",
      provider_repository_id: "R_kgDOABCDEF",
      connection_id: UUID_CONNECTION,
      configured_default_ref: "refs/heads/main",
      base_commit_sha: BASE_COMMIT_SHA,
      base_tree_sha: BASE_TREE_SHA,
    },
    workspace_policy: {
      sandbox_required: true,
      environment_id: UUID_ENVIRONMENT,
    },
    context_policy: {
      provider_allowlist: ["oxagen.graph", "repo.local"],
      max_frames: 24,
      max_tokens: 32_000,
      retention_policy_id: RETENTION_POLICY_PUBLIC_ID,
      retention_policy_digest: DIGEST_RETENTION,
    },
    tool_policy: {
      allowlist: ["edit_repo_file", "run_verification"],
      risk_ceiling: "high",
    },
    output_policy: {
      target_branch: "oxagen/retry-webhook",
      open_pull_request: true,
    },
  };
}

/** A general (non-repository) spec — no repository or output sections. */
function generalRaw(): Json {
  const raw = repoEditRaw();
  delete raw.repository_binding;
  delete raw.output_policy;
  raw.run_kind = "general";
  return raw;
}

/** Deep-set `path` (dot-delimited) on a structural clone of `base`. */
function mutate(base: Json, path: string, value: unknown): Json {
  const clone = structuredClone(base);
  const parts = path.split(".");
  let node = clone;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Json;
  }
  const [last] = parts.slice(-1);
  if (last !== undefined) node[last] = value;
  return clone;
}

/** Deep-delete `path` (dot-delimited) on a structural clone of `base`. */
function omit(base: Json, path: string): Json {
  const clone = structuredClone(base);
  const parts = path.split(".");
  let node = clone;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Json;
  }
  const [last] = parts.slice(-1);
  if (last !== undefined) delete node[last];
  return clone;
}

/** The trusted half of the fixture, as `buildTrustedRunSpecV2` takes it. */
function trustedRepoEditInput(): TrustedRunSpecV2Input {
  const raw = repoEditRaw();
  delete raw.version;
  delete raw.goal;
  return raw as unknown as TrustedRunSpecV2Input;
}

/** A parsed row-identity projection agreeing with the repo_edit fixture. */
function matchingRow(spec: RunSpecV2): RunRowIdentity {
  return {
    spec_version: 2,
    run_kind: "repo_edit",
    spec_digest: runSpecV2Digest(spec),
    initiating_principal_id: UUID_INITIATING,
    agent_principal_id: UUID_AGENT_PRINCIPAL,
    agent_id: UUID_AGENT,
    agent_version_id: UUID_AGENT_VERSION,
    agent_version_checksum: DIGEST_CHECKSUM,
    authorization_snapshot_id: UUID_SNAPSHOT,
    parent_run_id: null,
    repository_binding_public_id: REPOSITORY_BINDING_PUBLIC_ID,
    provider: "github",
    provider_repository_id: "R_kgDOABCDEF",
    connection_id: UUID_CONNECTION,
    configured_default_ref: "refs/heads/main",
    base_commit_sha: BASE_COMMIT_SHA,
    base_tree_sha: BASE_TREE_SHA,
    retention_policy_id: RETENTION_POLICY_PUBLIC_ID,
    retention_policy_digest: DIGEST_RETENTION,
    max_attempts: 3,
  };
}

// ── Canonical JSON (RFC 8785-compatible) ────────────────────────────────────

describe("canonicalJson", () => {
  it("sorts object keys at every depth and emits no insignificant whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("produces identical bytes for objects differing only in key order", () => {
    const left = { run_kind: "general", version: 2, nested: { z: 1, a: 2 } };
    const right = { nested: { a: 2, z: 1 }, version: 2, run_kind: "general" };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("preserves array order — order is meaning", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });

  it("sorts keys by UTF-16 code unit, not locale collation", () => {
    // "Z" (0x5A) sorts before "a" (0x61) by code unit; locale collation would
    // interleave them. RFC 8785 mandates code-unit order.
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  it("serializes the JSON scalars", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-17)).toBe("-17");
    expect(canonicalJson('hi\n"there"')).toBe('"hi\\n\\"there\\""');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("escapes non-ASCII exactly as UTF-8-bearing JSON strings", () => {
    expect(canonicalJson({ é: "ü" })).toBe('{"é":"ü"}');
  });

  it("treats an explicitly-undefined key as an absent key", () => {
    // Both are the same JSON document, so both must digest identically.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a float", 1.5],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "rejects %s rather than silently diverging the digest",
    (_label, value) => {
      expect(() => canonicalJson({ n: value })).toThrow(CanonicalJsonError);
    },
  );

  it("rejects undefined inside an array, where JSON.stringify would coerce to null", () => {
    expect(() => canonicalJson([1, undefined, 2])).toThrow(CanonicalJsonError);
  });

  it.each([
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a Date", new Date()],
    ["a Map", new Map()],
    ["a class instance", new (class Thing {})()],
  ])("rejects %s — only JSON values may be canonicalized", (_label, value) => {
    expect(() => canonicalJson({ v: value })).toThrow(CanonicalJsonError);
  });

  it("rejects a bare undefined at the root and labels the path <root>", () => {
    expect(() => canonicalJson(undefined)).toThrow(/<root>/);
  });

  it("names the offending path in the error", () => {
    expect(() => canonicalJson({ outer: { inner: [Number.NaN] } })).toThrow(
      /outer\.inner\.0/,
    );
  });

  it("canonicalizes a null-prototype object like a plain object", () => {
    const bare = Object.assign(Object.create(null) as Json, { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });
});

describe("digestOfCanonicalJson", () => {
  it("emits the algorithm-qualified sha256:<64 lowercase hex> form", () => {
    expect(digestOfCanonicalJson({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is stable across key order and sensitive to value change", () => {
    expect(digestOfCanonicalJson({ a: 1, b: 2 })).toBe(
      digestOfCanonicalJson({ b: 2, a: 1 }),
    );
    expect(digestOfCanonicalJson({ a: 1 })).not.toBe(
      digestOfCanonicalJson({ a: 2 }),
    );
  });

  it("matches the known RFC-8785 vector for the empty object", () => {
    // sha256 of the two bytes "{}" — pins the canonicalization, so swapping in
    // @oxagen/run-evidence later cannot silently change stored digests.
    expect(digestOfCanonicalJson({})).toBe(
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});

describe("assertSha256Digest", () => {
  it("returns the branded value for a well-formed digest", () => {
    expect(assertSha256Digest(DIGEST_CHECKSUM)).toBe(DIGEST_CHECKSUM);
  });

  it.each([
    ["a bare hex digest with no algorithm prefix", "a".repeat(64)],
    ["uppercase hex", `sha256:${"A".repeat(64)}`],
    ["a short digest", `sha256:${"a".repeat(63)}`],
    ["a long digest", `sha256:${"a".repeat(65)}`],
    ["a different algorithm", `sha512:${"a".repeat(64)}`],
    ["non-hex characters", `sha256:${"g".repeat(64)}`],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("rejects %s", (_label, value) => {
    expect(() => assertSha256Digest(value)).toThrow(RunSpecValidationError);
  });
});

describe("assertDecimalGeneration", () => {
  it.each(["0", "1", "12", "9007199254740993"])("accepts %s", (value) => {
    expect(assertDecimalGeneration(value)).toBe(value);
  });

  it.each([
    ["a leading zero", "01"],
    ["a negative value", "-1"],
    ["a float", "1.0"],
    ["a number rather than a decimal string", 1],
    ["an empty string", ""],
    ["whitespace padding", " 1"],
    ["a hex value", "0x1"],
  ])("rejects %s", (_label, value) => {
    expect(() => assertDecimalGeneration(value)).toThrow(
      RunSpecValidationError,
    );
  });
});

// ── Public id prefixes ──────────────────────────────────────────────────────

describe("reserved public id prefixes", () => {
  it("reserves exactly the ten evidence-domain prefixes", () => {
    expect(Object.values(RESERVED_PUBLIC_ID_PREFIXES).sort()).toEqual(
      [
        "afg_",
        "arat_",
        "arun_",
        "azd_",
        "evb_",
        "rpb_",
        "rpl_",
        "rpo_",
        "ras_",
        "revk_",
      ].sort(),
    );
  });

  it("is frozen so a caller cannot register a new reserved prefix at runtime", () => {
    expect(Object.isFrozen(RESERVED_PUBLIC_ID_PREFIXES)).toBe(true);
  });
});

// ── parseRunSpecV2 — happy paths ────────────────────────────────────────────

describe("parseRunSpecV2", () => {
  it("accepts a fully-pinned repo_edit spec", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(spec.run_kind).toBe("repo_edit");
    expect(spec.version).toBe(2);
    if (spec.run_kind !== "repo_edit") throw new Error("narrowing failed");
    expect(spec.repository_binding.base_commit_sha).toBe(BASE_COMMIT_SHA);
    expect(spec.output_policy.open_pull_request).toBe(true);
  });

  it("accepts a general spec with no repository or output sections", () => {
    const spec = parseRunSpecV2(generalRaw());
    expect(spec.run_kind).toBe("general");
    expect(spec.context_policy.retention_policy_id).toBe(
      RETENTION_POLICY_PUBLIC_ID,
    );
  });

  it("accepts an optional parent run binding for a child run", () => {
    const spec = parseRunSpecV2(
      mutate(repoEditRaw(), "actor_binding.parent_run_id", UUID_PARENT_RUN),
    );
    expect(spec.actor_binding.parent_run_id).toBe(UUID_PARENT_RUN);
  });

  it("returns a fresh object that does not alias the caller's input", () => {
    const raw = repoEditRaw();
    const spec = parseRunSpecV2(raw);
    expect(spec.engine_policy).not.toBe(raw.engine_policy);
    expect(spec.actor_binding).not.toBe(raw.actor_binding);
  });

  it.each([
    ["a non-object", "not a spec"],
    ["null", null],
    ["an array", []],
    ["undefined", undefined],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseRunSpecV2(raw)).toThrow(RunSpecValidationError);
  });

  it("reports the failing field path on the typed error", () => {
    try {
      parseRunSpecV2(mutate(repoEditRaw(), "engine_policy.max_attempts", 0));
      throw new Error("expected parseRunSpecV2 to throw");
    } catch (err) {
      if (!isRunSpecValidationError(err)) throw err;
      expect(err.code).toBe("run_spec_invalid");
      expect(err.issues.map((i) => i.path)).toContain(
        "engine_policy.max_attempts",
      );
      expect(err.message).toContain("engine_policy.max_attempts");
    }
  });
});

// ── parseRunSpecV2 — unknown fields ─────────────────────────────────────────

describe("parseRunSpecV2 unknown fields", () => {
  it.each([
    ["the spec root", "smuggled"],
    ["engine_policy", "engine_policy.smuggled"],
    ["actor_binding", "actor_binding.smuggled"],
    ["authorization_snapshot_ref", "authorization_snapshot_ref.smuggled"],
    [
      "the deny generation vector",
      "authorization_snapshot_ref.deny_generation_at_admission.smuggled",
    ],
    ["repository_binding", "repository_binding.smuggled"],
    ["workspace_policy", "workspace_policy.smuggled"],
    ["context_policy", "context_policy.smuggled"],
    ["tool_policy", "tool_policy.smuggled"],
    ["output_policy", "output_policy.smuggled"],
  ])("rejects an unknown key on %s", (_label, path) => {
    expect(() => parseRunSpecV2(mutate(repoEditRaw(), path, "x"))).toThrow(
      RunSpecValidationError,
    );
  });

  it("rejects a repository_binding on a general run", () => {
    const raw = generalRaw();
    raw.repository_binding = repoEditRaw().repository_binding;
    expect(() => parseRunSpecV2(raw)).toThrow(RunSpecValidationError);
  });

  it("rejects an output_policy on a general run", () => {
    const raw = generalRaw();
    raw.output_policy = repoEditRaw().output_policy;
    expect(() => parseRunSpecV2(raw)).toThrow(RunSpecValidationError);
  });

  it.each([
    ["repository_binding", "repository_binding"],
    ["output_policy", "output_policy"],
  ])("rejects a repo_edit run missing its %s", (_label, path) => {
    expect(() => parseRunSpecV2(omit(repoEditRaw(), path))).toThrow(
      RunSpecValidationError,
    );
  });

  it.each([
    "engine_policy",
    "actor_binding",
    "authorization_snapshot_ref",
    "workspace_policy",
    "context_policy",
    "tool_policy",
  ])("rejects a spec missing the %s section", (path) => {
    expect(() => parseRunSpecV2(omit(repoEditRaw(), path))).toThrow(
      RunSpecValidationError,
    );
  });

  it.each([
    ["an unknown run_kind", "run_kind", "admin_override"],
    ["a v1 version marker", "version", 1],
    ["a future version marker", "version", 3],
    ["a blank goal", "goal", "   "],
  ])("rejects %s", (_label, path, value) => {
    expect(() => parseRunSpecV2(mutate(repoEditRaw(), path, value))).toThrow(
      RunSpecValidationError,
    );
  });
});

// ── parseRunSpecV2 — malformed digests ──────────────────────────────────────

describe("parseRunSpecV2 digest fields", () => {
  const digestPaths = [
    "actor_binding.agent_version_checksum",
    "authorization_snapshot_ref.snapshot_digest",
    "authorization_snapshot_ref.grant_ceiling_digest",
    "context_policy.retention_policy_digest",
  ];

  it.each(digestPaths)(
    "requires an algorithm-qualified digest at %s",
    (path) => {
      expect(() =>
        parseRunSpecV2(mutate(repoEditRaw(), path, "a".repeat(64))),
      ).toThrow(RunSpecValidationError);
    },
  );

  it.each(digestPaths)("rejects uppercase hex at %s", (path) => {
    expect(() =>
      parseRunSpecV2(mutate(repoEditRaw(), path, `sha256:${"A".repeat(64)}`)),
    ).toThrow(RunSpecValidationError);
  });

  it.each(digestPaths)("rejects a truncated digest at %s", (path) => {
    expect(() =>
      parseRunSpecV2(mutate(repoEditRaw(), path, `sha256:${"a".repeat(32)}`)),
    ).toThrow(RunSpecValidationError);
  });

  it.each(digestPaths)("rejects a non-sha256 algorithm at %s", (path) => {
    expect(() =>
      parseRunSpecV2(mutate(repoEditRaw(), path, `sha1:${"a".repeat(40)}`)),
    ).toThrow(RunSpecValidationError);
  });
});

// ── parseRunSpecV2 — internal / public id confusion ─────────────────────────

describe("parseRunSpecV2 identifier kinds", () => {
  const uuidPaths = [
    "actor_binding.initiating_principal_id",
    "actor_binding.agent_principal_id",
    "actor_binding.agent_id",
    "actor_binding.agent_version_id",
    "actor_binding.parent_run_id",
    "authorization_snapshot_ref.snapshot_id",
    "repository_binding.connection_id",
    "workspace_policy.environment_id",
  ];

  it.each(uuidPaths)(
    "rejects a prefixed public id where %s expects a UUID",
    (path) => {
      expect(() =>
        parseRunSpecV2(mutate(repoEditRaw(), path, `arun_${"a".repeat(22)}`)),
      ).toThrow(RunSpecValidationError);
    },
  );

  it.each(uuidPaths)("rejects an uppercase UUID at %s", (path) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), path, UUID_MIXED_CASE.toUpperCase()),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each(uuidPaths)(
    "accepts the same UUID in canonical lowercase at %s",
    (path) => {
      expect(() =>
        parseRunSpecV2(mutate(repoEditRaw(), path, UUID_MIXED_CASE)),
      ).not.toThrow();
    },
  );

  it.each(uuidPaths)("rejects a dash-stripped UUID at %s", (path) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), path, UUID_INITIATING.replace(/-/g, "")),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects an internal UUID where the repository binding public id belongs", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(
          repoEditRaw(),
          "repository_binding.repository_binding_public_id",
          UUID_CONNECTION,
        ),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["a run public id", `arun_${"a".repeat(22)}`],
    ["an attempt public id", `arat_${"a".repeat(22)}`],
    ["an authorization snapshot public id", `ras_${"a".repeat(22)}`],
    ["an unprefixed opaque id", "a".repeat(22)],
    ["a non-hex suffix", `rpb_${"z".repeat(22)}`],
    ["a too-short suffix", "rpb_abc"],
    ["the bare prefix", "rpb_"],
  ])(
    "rejects %s where the repository binding public id belongs",
    (_label, value) => {
      expect(() =>
        parseRunSpecV2(
          mutate(
            repoEditRaw(),
            "repository_binding.repository_binding_public_id",
            value,
          ),
        ),
      ).toThrow(RunSpecValidationError);
    },
  );

  it.each([
    ["a run public id", `arun_${"a".repeat(22)}`],
    ["a repository binding public id", `rpb_${"a".repeat(22)}`],
    ["an evidence blob public id", `evb_${"a".repeat(22)}`],
    ["a path locator public id", `rpl_${"a".repeat(22)}`],
    ["an internal UUID", UUID_SNAPSHOT],
  ])(
    "rejects %s as a retention policy id — reserved prefixes are not reusable",
    (_label, value) => {
      expect(() =>
        parseRunSpecV2(
          mutate(repoEditRaw(), "context_policy.retention_policy_id", value),
        ),
      ).toThrow(RunSpecValidationError);
    },
  );

  it("accepts a non-reserved prefixed public id as the retention policy id", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(spec.context_policy.retention_policy_id).toBe(
      RETENTION_POLICY_PUBLIC_ID,
    );
  });

  it("keeps provider_repository_id an opaque provider string, not an Oxagen id", () => {
    const spec = parseRunSpecV2(
      mutate(
        repoEditRaw(),
        "repository_binding.provider_repository_id",
        "MDEwOlJlcG9zaXRvcnkxMjM0",
      ),
    );
    if (spec.run_kind !== "repo_edit") throw new Error("narrowing failed");
    expect(spec.repository_binding.provider_repository_id).toBe(
      "MDEwOlJlcG9zaXRvcnkxMjM0",
    );
  });
});

// ── parseRunSpecV2 — unpinned repository ────────────────────────────────────

describe("parseRunSpecV2 repository pinning", () => {
  it.each([
    "repository_binding.repository_binding_public_id",
    "repository_binding.provider",
    "repository_binding.provider_repository_id",
    "repository_binding.connection_id",
    "repository_binding.configured_default_ref",
    "repository_binding.base_commit_sha",
    "repository_binding.base_tree_sha",
  ])("rejects a repo_edit run with %s missing", (path) => {
    expect(() => parseRunSpecV2(omit(repoEditRaw(), path))).toThrow(
      RunSpecValidationError,
    );
  });

  it.each([
    ["a branch name", "main"],
    ["a symbolic ref", "HEAD"],
    ["an empty string", ""],
    ["a short sha", "abc1234"],
    ["an uppercase sha", "E".repeat(40)],
    ["a sha256 object id", "a".repeat(64)],
    ["an algorithm-qualified digest", `sha256:${"a".repeat(64)}`],
  ])(
    "rejects %s as base_commit_sha — the base must be an immutable commit",
    (_label, value) => {
      expect(() =>
        parseRunSpecV2(
          mutate(repoEditRaw(), "repository_binding.base_commit_sha", value),
        ),
      ).toThrow(RunSpecValidationError);
    },
  );

  it("rejects an unresolved base_tree_sha", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "repository_binding.base_tree_sha", "main"),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["an empty ref", ""],
    ["a whitespace ref", "  "],
    ["a ref with a path traversal", "refs/heads/../../etc"],
    ["a ref with a space", "refs/heads/my branch"],
    ["a ref starting with a dash", "-delete"],
  ])("rejects %s as configured_default_ref", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(
          repoEditRaw(),
          "repository_binding.configured_default_ref",
          value,
        ),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects an empty provider_repository_id — an unresolved repository is unpinned", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "repository_binding.provider_repository_id", ""),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects an unsupported repository provider", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "repository_binding.provider", "gitlab"),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects a repo_edit run that does not open a pull request", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "output_policy.open_pull_request", false),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("allows target_branch to be absent — the publisher resolves it", () => {
    const spec = parseRunSpecV2(
      omit(repoEditRaw(), "output_policy.target_branch"),
    );
    if (spec.run_kind !== "repo_edit") throw new Error("narrowing failed");
    expect(spec.output_policy.target_branch).toBeUndefined();
  });
});

// ── parseRunSpecV2 — workspace policy ───────────────────────────────────────

describe("parseRunSpecV2 workspace policy", () => {
  it.each([
    ["false", false],
    ["a truthy string", "true"],
    ["1", 1],
    ["null", null],
  ])(
    "rejects sandbox_required = %s — a governed run is sandbox-only",
    (_label, value) => {
      expect(() =>
        parseRunSpecV2(
          mutate(repoEditRaw(), "workspace_policy.sandbox_required", value),
        ),
      ).toThrow(RunSpecValidationError);
    },
  );

  it("rejects a workspace policy with sandbox_required missing", () => {
    expect(() =>
      parseRunSpecV2(omit(repoEditRaw(), "workspace_policy.sandbox_required")),
    ).toThrow(RunSpecValidationError);
  });

  it("allows environment_id to be absent", () => {
    const spec = parseRunSpecV2(
      omit(repoEditRaw(), "workspace_policy.environment_id"),
    );
    expect(spec.workspace_policy.environment_id).toBeUndefined();
    expect(spec.workspace_policy.sandbox_required).toBe(true);
  });
});

// ── parseRunSpecV2 — engine policy ──────────────────────────────────────────

describe("parseRunSpecV2 engine policy", () => {
  it.each([
    ["an empty allowlist", []],
    ["a floating version", ["2.1"]],
    ["a v-prefixed version", ["v2.1.0"]],
    ["a range expression", ["^2.1.0"]],
    ["a wildcard", ["2.x"]],
    ["a latest alias", ["latest"]],
    ["an empty string version", [""]],
    ["a duplicated version", ["2.1.0", "2.1.0"]],
    ["a non-array", "2.1.0"],
  ])("rejects %s for allowed_engine_versions", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "engine_policy.allowed_engine_versions", value),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("accepts exact semantic versions including prerelease and build metadata", () => {
    const spec = parseRunSpecV2(
      mutate(repoEditRaw(), "engine_policy.allowed_engine_versions", [
        "2.1.0",
        "3.0.0-rc.2",
        "3.0.0+build.7",
      ]),
    );
    expect(spec.engine_policy.allowed_engine_versions).toHaveLength(3);
  });

  it("rejects an unknown requested engine", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "engine_policy.requested_engine", "acme"),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["zero", 0],
    ["a negative count", -1],
    ["a float", 2.5],
    ["a value above the admission ceiling", 1_000],
    ["a decimal string", "3"],
  ])("rejects max_attempts = %s", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "engine_policy.max_attempts", value),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["zero", 0],
    ["a float", 8.5],
    ["a value above the admission ceiling", 100_000],
  ])("rejects max_steps = %s", (_label, value) => {
    expect(() =>
      parseRunSpecV2(mutate(repoEditRaw(), "engine_policy.max_steps", value)),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects an empty model_policy_ref", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "engine_policy.model_policy_ref", ""),
      ),
    ).toThrow(RunSpecValidationError);
  });
});

// ── parseRunSpecV2 — authorization snapshot + context/tool policy ───────────

describe("parseRunSpecV2 authorization snapshot reference", () => {
  it.each([
    ["a missing org generation", { workspace: "0" }],
    ["a missing workspace generation", { org: "1" }],
    ["a numeric generation", { org: 1, workspace: 0 }],
    ["a negative generation", { org: "-1", workspace: "0" }],
    ["a leading-zero generation", { org: "01", workspace: "0" }],
    ["a null vector", null],
  ])("rejects %s in the deny generation vector", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(
          repoEditRaw(),
          "authorization_snapshot_ref.deny_generation_at_admission",
          value,
        ),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("preserves a generation beyond Number.MAX_SAFE_INTEGER as an exact decimal string", () => {
    const huge = "9007199254740993";
    const spec = parseRunSpecV2(
      mutate(
        repoEditRaw(),
        "authorization_snapshot_ref.deny_generation_at_admission",
        { org: huge, workspace: "0" },
      ),
    );
    expect(
      spec.authorization_snapshot_ref.deny_generation_at_admission.org,
    ).toBe(huge);
  });

  it.each([
    ["a date-only value", "2026-07-21"],
    ["a naive timestamp with no zone", "2026-07-21T10:00:00"],
    ["a unix epoch number", 1_784_000_000],
    ["free text", "yesterday"],
    ["an impossible instant", "2026-13-45T99:00:00Z"],
  ])("rejects %s as resolved_at", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "authorization_snapshot_ref.resolved_at", value),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("accepts an RFC 3339 offset timestamp", () => {
    const spec = parseRunSpecV2(
      mutate(
        repoEditRaw(),
        "authorization_snapshot_ref.resolved_at",
        "2026-07-21T10:00:00+02:00",
      ),
    );
    expect(spec.authorization_snapshot_ref.resolved_at).toBe(
      "2026-07-21T10:00:00+02:00",
    );
  });
});

describe("parseRunSpecV2 context and tool policy", () => {
  it("accepts an empty provider allowlist — a run may frame no context", () => {
    const spec = parseRunSpecV2(
      mutate(repoEditRaw(), "context_policy.provider_allowlist", []),
    );
    expect(spec.context_policy.provider_allowlist).toEqual([]);
  });

  it.each([
    ["a duplicate provider", ["a", "a"]],
    ["an empty provider id", [""]],
    ["a non-string provider", [1]],
  ])("rejects %s in the provider allowlist", (_label, value) => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "context_policy.provider_allowlist", value),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["max_frames", "context_policy.max_frames"],
    ["max_tokens", "context_policy.max_tokens"],
  ])("rejects a negative %s", (_label, path) => {
    expect(() => parseRunSpecV2(mutate(repoEditRaw(), path, -1))).toThrow(
      RunSpecValidationError,
    );
  });

  it("rejects an unknown risk ceiling", () => {
    expect(() =>
      parseRunSpecV2(
        mutate(repoEditRaw(), "tool_policy.risk_ceiling", "unlimited"),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each(["low", "medium", "high", "critical"])(
    "accepts the %s risk ceiling",
    (value) => {
      const spec = parseRunSpecV2(
        mutate(repoEditRaw(), "tool_policy.risk_ceiling", value),
      );
      expect(spec.tool_policy.risk_ceiling).toBe(value);
    },
  );

  it("accepts an empty tool allowlist — a run may be permitted no tools", () => {
    const spec = parseRunSpecV2(
      mutate(repoEditRaw(), "tool_policy.allowlist", []),
    );
    expect(spec.tool_policy.allowlist).toEqual([]);
  });

  it.each([
    ["a duplicate capability", ["edit_repo_file", "edit_repo_file"]],
    ["a wildcard", ["*"]],
    ["an empty capability name", [""]],
  ])("rejects %s in the tool allowlist", (_label, value) => {
    expect(() =>
      parseRunSpecV2(mutate(repoEditRaw(), "tool_policy.allowlist", value)),
    ).toThrow(RunSpecValidationError);
  });
});

// ── Caller influence — the trusted-field boundary ───────────────────────────

describe("parseCallerRunInfluence", () => {
  it("accepts a goal alone", () => {
    expect(parseCallerRunInfluence({ goal: "ship it" })).toEqual({
      goal: "ship it",
    });
  });

  it("accepts bounded advisory preferences", () => {
    const influence = parseCallerRunInfluence({
      goal: "ship it",
      preferences: { requested_engine: "stella", max_steps: 8 },
    });
    expect(influence.preferences?.max_steps).toBe(8);
  });

  it.each([
    ["a blank goal", { goal: "  " }],
    ["a missing goal", {}],
    ["a non-string goal", { goal: 42 }],
    ["an unknown preference", { goal: "g", preferences: { model: "gpt" } }],
    // Not a trusted section, so the section guard never sees it — `.strict()`
    // is the only thing standing between this and a silently-ignored field.
    ["an unknown top-level key", { goal: "g", foo: 1 }],
    ["a non-object", "goal"],
    ["null", null],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseCallerRunInfluence(raw)).toThrow(RunSpecValidationError);
  });

  it.each(TRUSTED_RUN_SPEC_SECTIONS)(
    "rejects a caller-supplied %s section",
    (section) => {
      const raw = { goal: "ship it", [section]: {} };
      expect(() => parseCallerRunInfluence(raw)).toThrow(
        RunSpecValidationError,
      );
    },
  );
});

describe("buildTrustedRunSpecV2", () => {
  const influence: CallerRunInfluence = { goal: "Add a retry" };

  it("assembles a valid spec from trusted sections plus the caller's goal", () => {
    const spec = buildTrustedRunSpecV2(trustedRepoEditInput(), influence);
    expect(spec.version).toBe(2);
    expect(spec.goal).toBe("Add a retry");
    expect(spec.run_kind).toBe("repo_edit");
    expect(spec).toEqual(
      parseRunSpecV2({ ...repoEditRaw(), goal: "Add a retry" }),
    );
  });

  it("builds a general spec with no repository or output section", () => {
    const trusted = trustedRepoEditInput() as unknown as Json;
    delete trusted.repository_binding;
    delete trusted.output_policy;
    trusted.run_kind = "general";
    const spec = buildTrustedRunSpecV2(
      trusted as unknown as TrustedRunSpecV2Input,
      influence,
    );
    expect(spec.run_kind).toBe("general");
    expect(spec).not.toHaveProperty("repository_binding");
  });

  it("hard-codes version 2 — a caller cannot select the spec version", () => {
    const trusted = trustedRepoEditInput() as unknown as Json;
    trusted.version = 1;
    const spec = buildTrustedRunSpecV2(
      trusted as unknown as TrustedRunSpecV2Input,
      influence,
    );
    expect(spec.version).toBe(2);
  });

  it.each(TRUSTED_RUN_SPEC_SECTIONS)(
    "throws UntrustedRunSpecFieldError when caller influence carries %s",
    (section) => {
      // The `& { [K in TrustedRunSpecSection]?: never }` type makes this a
      // compile error; the cast proves the RUNTIME guard also holds, which is
      // what matters at an `unknown`-typed transport boundary.
      const hostile = {
        goal: "ship it",
        [section]: { smuggled: true },
      } as unknown as CallerRunInfluence;
      expect(() =>
        buildTrustedRunSpecV2(trustedRepoEditInput(), hostile),
      ).toThrow(UntrustedRunSpecFieldError);
    },
  );

  it("names the smuggled field on the typed error", () => {
    const hostile = {
      goal: "ship it",
      actor_binding: { initiating_principal_id: UUID_AGENT },
    } as unknown as CallerRunInfluence;
    try {
      buildTrustedRunSpecV2(trustedRepoEditInput(), hostile);
      throw new Error("expected buildTrustedRunSpecV2 to throw");
    } catch (err) {
      if (!isUntrustedRunSpecFieldError(err)) throw err;
      expect(err.code).toBe("run_spec_untrusted_field");
      expect(err.fields).toEqual(["actor_binding"]);
      expect(err.message).toContain("actor_binding");
    }
  });

  it("reports every smuggled field, not just the first", () => {
    const hostile = {
      goal: "ship it",
      actor_binding: {},
      tool_policy: {},
    } as unknown as CallerRunInfluence;
    try {
      buildTrustedRunSpecV2(trustedRepoEditInput(), hostile);
      throw new Error("expected buildTrustedRunSpecV2 to throw");
    } catch (err) {
      if (!isUntrustedRunSpecFieldError(err)) throw err;
      expect(err.fields).toEqual(["actor_binding", "tool_policy"]);
    }
  });

  it("never lets a caller preference reach a trusted engine field", () => {
    const spec = buildTrustedRunSpecV2(trustedRepoEditInput(), {
      goal: "ship it",
      // max_steps carries the contrast now: both preferences are well-formed,
      // and this one disagrees with what the trusted resolver decided. The
      // engine field cannot disagree any more — Stella is the only admissible
      // value — so it asserts only that the resolver's value is what lands.
      preferences: { requested_engine: "stella", max_steps: 4096 },
    });
    expect(spec.engine_policy.requested_engine).toBe("stella");
    expect(spec.engine_policy.max_steps).toBe(64);
    expect(spec).not.toHaveProperty("preferences");
  });

  it("rejects a preference that exceeds the admission ceiling outright", () => {
    expect(() =>
      buildTrustedRunSpecV2(trustedRepoEditInput(), {
        goal: "ship it",
        preferences: { max_steps: 100_000 },
      }),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects trusted input that does not itself satisfy the schema", () => {
    const trusted = trustedRepoEditInput() as unknown as Json;
    (trusted.workspace_policy as Json).sandbox_required = false;
    expect(() =>
      buildTrustedRunSpecV2(
        trusted as unknown as TrustedRunSpecV2Input,
        influence,
      ),
    ).toThrow(RunSpecValidationError);
  });

  it.each([
    ["null", null],
    ["a string", "just a goal"],
  ])("rejects %s as the caller influence object", (_label, hostile) => {
    expect(() =>
      buildTrustedRunSpecV2(
        trustedRepoEditInput(),
        hostile as unknown as CallerRunInfluence,
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects an invalid caller goal before touching trusted state", () => {
    expect(() =>
      buildTrustedRunSpecV2(trustedRepoEditInput(), {
        goal: "   ",
      } as CallerRunInfluence),
    ).toThrow(RunSpecValidationError);
  });

  it("returns a spec that does not alias the trusted input's sections", () => {
    const trusted = trustedRepoEditInput();
    const spec = buildTrustedRunSpecV2(trusted, influence);
    expect(spec.engine_policy).not.toBe(trusted.engine_policy);
  });
});

// ── Spec digest + row/spec identity ─────────────────────────────────────────

describe("runSpecV2Digest", () => {
  it("is deterministic for the same spec", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(runSpecV2Digest(spec)).toBe(runSpecV2Digest(spec));
  });

  it("is independent of source key order", () => {
    const forward = parseRunSpecV2(repoEditRaw());
    const reversed = parseRunSpecV2(
      Object.fromEntries(Object.entries(repoEditRaw()).reverse()),
    );
    expect(runSpecV2Digest(forward)).toBe(runSpecV2Digest(reversed));
  });

  it("changes when any pinned field changes", () => {
    const base = runSpecV2Digest(parseRunSpecV2(repoEditRaw()));
    const tampered = runSpecV2Digest(
      parseRunSpecV2(
        mutate(
          repoEditRaw(),
          "repository_binding.base_commit_sha",
          "1".repeat(40),
        ),
      ),
    );
    expect(tampered).not.toBe(base);
  });

  it("distinguishes a general run from a repo_edit run", () => {
    expect(runSpecV2Digest(parseRunSpecV2(generalRaw()))).not.toBe(
      runSpecV2Digest(parseRunSpecV2(repoEditRaw())),
    );
  });

  it("emits an algorithm-qualified digest", () => {
    expect(runSpecV2Digest(parseRunSpecV2(repoEditRaw()))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

describe("assertRunSpecV2Digest", () => {
  it("passes when the stored digest matches the recomputed one", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(() =>
      assertRunSpecV2Digest(spec, runSpecV2Digest(spec)),
    ).not.toThrow();
  });

  it("throws RunSpecDigestMismatchError when the stored digest disagrees", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    try {
      assertRunSpecV2Digest(spec, `sha256:${"9".repeat(64)}`);
      throw new Error("expected assertRunSpecV2Digest to throw");
    } catch (err) {
      if (!(err instanceof RunSpecDigestMismatchError)) throw err;
      expect(err.code).toBe("run_spec_digest_mismatch");
      expect(err.expected).toBe(`sha256:${"9".repeat(64)}`);
      expect(err.actual).toBe(runSpecV2Digest(spec));
    }
  });

  it("rejects a malformed stored digest rather than comparing it", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(() => assertRunSpecV2Digest(spec, "not-a-digest")).toThrow(
      RunSpecValidationError,
    );
  });
});

describe("compareRunRowIdentity", () => {
  it("reports no mismatches when the row agrees with the spec", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(compareRunRowIdentity(matchingRow(spec), spec)).toEqual([]);
  });

  it.each([
    ["spec_version", 1],
    ["run_kind", "general"],
    ["initiating_principal_id", UUID_AGENT],
    ["agent_principal_id", UUID_AGENT],
    ["agent_id", UUID_INITIATING],
    ["agent_version_id", UUID_INITIATING],
    ["agent_version_checksum", DIGEST_SNAPSHOT],
    ["authorization_snapshot_id", UUID_AGENT],
    ["parent_run_id", UUID_PARENT_RUN],
    ["repository_binding_public_id", `rpb_${"9".repeat(22)}`],
    ["provider", "gitlab"],
    ["provider_repository_id", "R_other"],
    ["connection_id", UUID_AGENT],
    ["configured_default_ref", "refs/heads/other"],
    ["base_commit_sha", "1".repeat(40)],
    ["base_tree_sha", "1".repeat(40)],
    ["retention_policy_id", `rtn_${"9".repeat(22)}`],
    ["retention_policy_digest", DIGEST_SNAPSHOT],
    ["max_attempts", 9],
  ])("detects a divergent %s column", (field, rowValue) => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row = { ...matchingRow(spec), [field]: rowValue };
    const mismatches = compareRunRowIdentity(row, spec);
    expect(mismatches.map((m) => m.field)).toEqual([field]);
    expect(mismatches[0]?.row).toEqual(rowValue);
  });

  it("reports every divergent column, not just the first", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row = {
      ...matchingRow(spec),
      agent_id: UUID_INITIATING,
      max_attempts: 9,
    };
    expect(compareRunRowIdentity(row, spec).map((m) => m.field)).toEqual([
      "agent_id",
      "max_attempts",
    ]);
  });

  it("requires the repository columns to be null for a general run", () => {
    const spec = parseRunSpecV2(generalRaw());
    const row: RunRowIdentity = {
      ...matchingRow(spec),
      run_kind: "general",
      spec_digest: runSpecV2Digest(spec),
    };
    // The fixture row still carries repository columns; a general spec has none.
    expect(compareRunRowIdentity(row, spec).map((m) => m.field)).toEqual([
      "repository_binding_public_id",
      "provider",
      "provider_repository_id",
      "connection_id",
      "configured_default_ref",
      "base_commit_sha",
      "base_tree_sha",
    ]);
  });

  it("accepts a general run whose repository columns are null", () => {
    const spec = parseRunSpecV2(generalRaw());
    const row: RunRowIdentity = {
      ...matchingRow(spec),
      run_kind: "general",
      spec_digest: runSpecV2Digest(spec),
      repository_binding_public_id: null,
      provider: null,
      provider_repository_id: null,
      connection_id: null,
      configured_default_ref: null,
      base_commit_sha: null,
      base_tree_sha: null,
    };
    expect(compareRunRowIdentity(row, spec)).toEqual([]);
  });

  it("detects a repo_edit row whose repository columns were nulled out", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row: RunRowIdentity = { ...matchingRow(spec), base_commit_sha: null };
    expect(compareRunRowIdentity(row, spec).map((m) => m.field)).toEqual([
      "base_commit_sha",
    ]);
  });

  it("treats an absent optional parent binding as null, not undefined", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row: RunRowIdentity = { ...matchingRow(spec), parent_run_id: null };
    expect(compareRunRowIdentity(row, spec)).toEqual([]);
  });

  it("matches a child run against its parent column", () => {
    const spec = parseRunSpecV2(
      mutate(repoEditRaw(), "actor_binding.parent_run_id", UUID_PARENT_RUN),
    );
    const row: RunRowIdentity = {
      ...matchingRow(spec),
      spec_digest: runSpecV2Digest(spec),
      parent_run_id: UUID_PARENT_RUN,
    };
    expect(compareRunRowIdentity(row, spec)).toEqual([]);
  });
});

describe("assertRunRowMatchesSpec", () => {
  it("passes for an agreeing row", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    expect(() =>
      assertRunRowMatchesSpec(matchingRow(spec), spec),
    ).not.toThrow();
  });

  it("fails on a tampered spec digest before comparing columns", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row: RunRowIdentity = {
      ...matchingRow(spec),
      spec_digest: `sha256:${"9".repeat(64)}`,
      agent_id: UUID_INITIATING,
    };
    expect(() => assertRunRowMatchesSpec(row, spec)).toThrow(
      RunSpecDigestMismatchError,
    );
  });

  it("throws RunSpecIdentityMismatchError listing the divergent columns", () => {
    const spec = parseRunSpecV2(repoEditRaw());
    const row: RunRowIdentity = {
      ...matchingRow(spec),
      agent_id: UUID_INITIATING,
      max_attempts: 9,
    };
    try {
      assertRunRowMatchesSpec(row, spec);
      throw new Error("expected assertRunRowMatchesSpec to throw");
    } catch (err) {
      if (!(err instanceof RunSpecIdentityMismatchError)) throw err;
      expect(err.code).toBe("run_spec_identity_mismatch");
      expect(err.mismatches.map((m) => m.field)).toEqual([
        "agent_id",
        "max_attempts",
      ]);
      expect(err.message).toContain("agent_id");
    }
  });
});

// ── Typed error guards ──────────────────────────────────────────────────────

describe("run error guards", () => {
  it("matches its own error instances", () => {
    expect(
      isRunSpecValidationError(new RunSpecValidationError("nope", [])),
    ).toBe(true);
    expect(
      isUntrustedRunSpecFieldError(new UntrustedRunSpecFieldError(["x"])),
    ).toBe(true);
  });

  it("matches structurally across a duplicated class identity", () => {
    const structural = Object.assign(new Error("copy"), {
      code: "run_spec_invalid",
    });
    expect(isRunSpecValidationError(structural)).toBe(true);
  });

  it("does not match unrelated errors or non-errors", () => {
    expect(isRunSpecValidationError(new Error("plain"))).toBe(false);
    expect(isRunSpecValidationError({ code: "run_spec_invalid" })).toBe(false);
    expect(isUntrustedRunSpecFieldError(new Error("plain"))).toBe(false);
    expect(isUntrustedRunSpecFieldError(null)).toBe(false);
  });

  it("keeps the issue list on a validation error", () => {
    const err = new RunSpecValidationError("bad", [
      { path: "a.b", message: "required" },
    ]);
    expect(err.name).toBe("RunSpecValidationError");
    expect(err.issues).toEqual([{ path: "a.b", message: "required" }]);
  });

  it("keeps a validation error's message intact when it has no issues", () => {
    expect(new RunSpecValidationError("bad", []).message).toBe("bad");
  });

  it("matches digest and identity mismatch errors both ways", () => {
    const digest = new RunSpecDigestMismatchError("sha256:a", "sha256:b");
    const identity = new RunSpecIdentityMismatchError([
      { field: "agent_id", row: "x", spec: "y" },
    ]);
    expect(isRunSpecDigestMismatchError(digest)).toBe(true);
    expect(isRunSpecIdentityMismatchError(identity)).toBe(true);
    expect(
      isRunSpecDigestMismatchError(
        Object.assign(new Error("copy"), { code: "run_spec_digest_mismatch" }),
      ),
    ).toBe(true);
    expect(
      isRunSpecIdentityMismatchError(
        Object.assign(new Error("copy"), {
          code: "run_spec_identity_mismatch",
        }),
      ),
    ).toBe(true);
    expect(isRunSpecDigestMismatchError(identity)).toBe(false);
    expect(isRunSpecIdentityMismatchError(digest)).toBe(false);
  });

  it("renders null, undefined, and object values in an identity mismatch message", () => {
    const err = new RunSpecIdentityMismatchError([
      { field: "base_commit_sha", row: null, spec: undefined },
      { field: "engine_policy", row: { a: 1 }, spec: "x" },
    ]);
    expect(err.message).toContain("row=null, spec=undefined");
    expect(err.message).toContain('row={"a":1}, spec=x');
  });
});
