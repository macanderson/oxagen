import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
const oxagenRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../../node_modules/.bin/tsx", import.meta.url),
);
const EXPECTED_UPSTREAM_REPOSITORY =
  "https://github.com/macanderson/context-graph-protocol";
const OXAGEN_REPOSITORY = "https://github.com/oxageninc/oxagen-platform";
const temporaryDirectories: string[] = [];

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

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "oxagen-contextgraph-"));
  temporaryDirectories.push(directory);
  return directory;
}

function baseGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL =
    process.platform === "win32" ? "NUL" : "/dev/null";
  return environment;
}

function runFixtureCheck(
  checkoutDirectory: string,
  gitEnvironment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(tsxPath, [fileURLToPath(rootScriptUrl)], {
    cwd: oxagenRoot,
    encoding: "utf8",
    env: {
      ...baseGitEnvironment(),
      CONTEXT_GRAPH_PROTOCOL_DIR: checkoutDirectory,
      ...gitEnvironment,
    },
  });
}

function runTestGit(arguments_: readonly string[]): string {
  const result = spawnSync("git", arguments_, {
    encoding: "utf8",
    env: baseGitEnvironment(),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.replace(/(?:\r?\n)+$/, "");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

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
      "9fb559aa4d3ec4cf062e59dab113eae4e175c5fa",
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

  it("requires exactly the manifest and the five fixture payloads", () => {
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

  it("ignores ambient Git repository selection for a non-repository path", () => {
    const fakeCheckout = makeTemporaryDirectory();
    const result = runFixtureCheck(fakeCheckout, {
      GIT_DIR: resolve(oxagenRoot, ".git"),
      GIT_WORK_TREE: fakeCheckout,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `- upstream checkout: ${realpathSync(fakeCheckout)} is not a local Git checkout root:`,
    );
  });

  it("ignores ambient Git URL rewrites when checking the selected origin", () => {
    const checkout = makeTemporaryDirectory();
    runTestGit(["init", "--quiet", checkout]);
    runTestGit([
      "-C",
      checkout,
      "config",
      "remote.origin.url",
      `${OXAGEN_REPOSITORY}.git`,
    ]);

    const result = runFixtureCheck(checkout, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${EXPECTED_UPSTREAM_REPOSITORY}.insteadOf`,
      GIT_CONFIG_VALUE_0: OXAGEN_REPOSITORY,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `- upstream checkout origin: expected ${EXPECTED_UPSTREAM_REPOSITORY}, observed ${OXAGEN_REPOSITORY}`,
    );
  });

  it("checks the raw local origin behind a repository-local URL rewrite", () => {
    const checkout = makeTemporaryDirectory();
    runTestGit(["init", "--quiet", checkout]);
    runTestGit([
      "-C",
      checkout,
      "config",
      "remote.origin.url",
      `${OXAGEN_REPOSITORY}.git`,
    ]);
    runTestGit([
      "-C",
      checkout,
      "config",
      `url.${EXPECTED_UPSTREAM_REPOSITORY}.insteadOf`,
      OXAGEN_REPOSITORY,
    ]);
    expect(runTestGit(["-C", checkout, "remote", "get-url", "origin"])).toBe(
      `${EXPECTED_UPSTREAM_REPOSITORY}.git`,
    );

    const result = runFixtureCheck(checkout);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `- upstream checkout raw local origin: expected ${EXPECTED_UPSTREAM_REPOSITORY}, observed ${OXAGEN_REPOSITORY}`,
    );
  });

  it("rejects a missing raw local origin", () => {
    const checkout = makeTemporaryDirectory();
    runTestGit(["init", "--quiet", checkout]);

    const result = runFixtureCheck(checkout);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "- upstream checkout raw local origin: expected exactly one remote.origin.url value, observed none",
    );
  });

  it("rejects multiple raw local origins", () => {
    const checkout = makeTemporaryDirectory();
    runTestGit(["init", "--quiet", checkout]);
    runTestGit([
      "-C",
      checkout,
      "config",
      "--add",
      "remote.origin.url",
      `${EXPECTED_UPSTREAM_REPOSITORY}.git`,
    ]);
    runTestGit([
      "-C",
      checkout,
      "config",
      "--add",
      "remote.origin.url",
      `${EXPECTED_UPSTREAM_REPOSITORY}.git`,
    ]);

    const result = runFixtureCheck(checkout);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "- upstream checkout raw local origin: expected exactly one remote.origin.url value, observed 2",
    );
  });

  it("reports every child-process failure as one bullet line", () => {
    const result = runFixtureCheck(makeTemporaryDirectory());
    const nonemptyLines = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.length > 0);

    expect(result.status).toBe(1);
    expect(nonemptyLines[0]).toBe("Context Graph fixture drift check failed:");
    expect(nonemptyLines.slice(1).every((line) => line.startsWith("- "))).toBe(
      true,
    );
  });
});
