import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "./digest.js";

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
const rootPackageUrl = new URL("../../../package.json", import.meta.url);
const rootScriptUrl = new URL(
  "../../../tools/scripts/check-contextgraph-fixtures.ts",
  import.meta.url,
);

const EXPECTED_FILE_DIGESTS = {
  "context-frame.missing-citation.invalid.json":
    "sha256:f2c9369017e26b4b9a62441ee6eb947d3813d0c9e16dfd4bcdd178ec85434ef0",
  "context-frame.valid.json":
    "sha256:96ac76616eb40caf5f8fb976c7fb6db6fd2b6c68251b550e2ba8910934c1a8f4",
  "context-query.valid.json":
    "sha256:affb3c2df4e9623073836e06fb9f02f54a1ac0cf5d40051b9173818679718f45",
  "normalization-vectors.json":
    "sha256:0cb074c68e06a11081313118bf046dd45e432b412992429b287db3dc46f628db",
  "strict-validation.invalid.json":
    "sha256:cc651deec23c1296227fd751c41f0c19570c86384a50c178a6c80efa380fa8ed",
} as const;

const EXPECTED_WRAPPER_KEYS = [
  "files",
  "fixture_profile_version",
  "generation_command",
  "protocol_version",
  "upstream_commit",
  "upstream_manifest_sha256",
  "upstream_repository",
] as const;

function readManifest(): FixtureManifest {
  return JSON.parse(
    readFileSync(new URL("manifest.json", fixtureDirectory), "utf8"),
  ) as FixtureManifest;
}

describe("Context Graph fixture drift lock", () => {
  it("wires the standalone root check", () => {
    const rootPackage = JSON.parse(readFileSync(rootPackageUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.["check:contextgraph-fixtures"]).toBe(
      "tsx tools/scripts/check-contextgraph-fixtures.ts",
    );
    expect(existsSync(rootScriptUrl)).toBe(true);
  });

  it("pins the exact wrapper shape and upstream identity", () => {
    const manifest = readManifest();

    expect(Object.keys(manifest).sort()).toEqual(EXPECTED_WRAPPER_KEYS);
    expect(manifest.protocol_version).toBe("contextgraph/1.0-draft");
    expect(manifest.fixture_profile_version).toBe("1.1.0");
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
  });

  it("pins the exact manifest file map and canonical digests", () => {
    const manifest = readManifest();

    expect(manifest.files).toEqual(EXPECTED_FILE_DIGESTS);
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(digest, name).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("requires exactly the six regular fixture files", () => {
    const entries = readdirSync(fixtureDirectory, { withFileTypes: true });

    expect(entries.every((entry) => entry.isFile())).toBe(true);
    expect(entries.map(({ name }) => name).sort()).toEqual(
      ["manifest.json", ...Object.keys(EXPECTED_FILE_DIGESTS)].sort(),
    );
  });

  it("matches every vendored payload's raw-byte digest", () => {
    for (const [name, expectedDigest] of Object.entries(
      EXPECTED_FILE_DIGESTS,
    )) {
      const bytes = readFileSync(new URL(name, fixtureDirectory));
      expect(sha256Digest(bytes), name).toBe(expectedDigest);
    }
  });
});
