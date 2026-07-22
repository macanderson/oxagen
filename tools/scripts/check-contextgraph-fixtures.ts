#!/usr/bin/env tsx

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const EXPECTED_PROTOCOL_VERSION = "contextgraph/1.0-draft";
const EXPECTED_FIXTURE_PROFILE_VERSION = "1.1.0";
const EXPECTED_GENERATION_COMMAND =
  "cargo test -p contextgraph-conformance --test golden_fixtures";
const EXPECTED_UPSTREAM_REPOSITORY =
  "https://github.com/macanderson/context-graph-protocol";
const EXPECTED_UPSTREAM_COMMIT = "36a64488f0fe300597ab494e1c4f9e94778175a0";
const EXPECTED_UPSTREAM_MANIFEST_SHA256 =
  "sha256:bae644ace4444881450af4f69b3a89e4d2178cc60f4c3a5b7adb3350327d437a";

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

const EXPECTED_UPSTREAM_MANIFEST_KEYS = [
  "files",
  "fixture_profile_version",
  "generation_command",
  "protocol_version",
] as const;

const EXPECTED_FILE_NAMES = Object.keys(EXPECTED_FILE_DIGESTS).sort();
const EXPECTED_DIRECTORY_ENTRIES = [
  "manifest.json",
  ...EXPECTED_FILE_NAMES,
].sort();
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const oxagenRoot = fileURLToPath(new URL("../../", import.meta.url));
const vendoredFixtureDirectory = resolve(
  oxagenRoot,
  "packages/run-evidence/fixtures/contextgraph",
);

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
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

const localGitEnvironment = sanitizedGitEnvironment();

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function observedValue(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (
    value === null ||
    ["boolean", "number", "string"].includes(typeof value)
  ) {
    return JSON.stringify(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function singleLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\t ]+/g, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return singleLine(error instanceof Error ? error.message : String(error));
}

function exactKeyErrors(
  label: string,
  value: JsonObject,
  expected: readonly string[],
): string[] {
  const errors: string[] = [];
  const actual = Object.keys(value).sort();
  const actualKeys = new Set(actual);
  const expectedKeys = new Set(expected);

  for (const key of expected) {
    if (!actualKeys.has(key)) {
      errors.push(`${label}: missing key "${key}"`);
    }
  }
  for (const key of actual) {
    if (!expectedKeys.has(key)) {
      errors.push(`${label}: unexpected key "${key}"`);
    }
  }

  return errors;
}

function exactDirectoryEntryErrors(
  label: string,
  directory: string,
  expected: readonly string[],
): string[] {
  const errors: string[] = [];

  try {
    if (!lstatSync(directory).isDirectory()) {
      return [`${label}: expected a directory at ${directory}`];
    }
  } catch (error) {
    return [
      `${label}: directory is missing or unreadable at ${directory} (${errorMessage(error)})`,
    ];
  }

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return [
      `${label}: unable to list directory ${directory} (${errorMessage(error)})`,
    ];
  }

  const expectedNames = new Set(expected);
  const actualNames = new Set(entries.map(({ name }) => name));

  for (const name of expected) {
    if (!actualNames.has(name)) {
      errors.push(`${label}: missing directory entry "${name}"`);
    }
  }
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!expectedNames.has(entry.name)) {
      errors.push(`${label}: unexpected directory entry "${entry.name}"`);
    }
    if (!entry.isFile()) {
      errors.push(`${label}: entry "${entry.name}" is not a regular file`);
    }
  }

  return errors;
}

function readJsonObject(path: string, label: string): JsonObject {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `${label}: unable to read ${path} (${errorMessage(error)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `${label}: invalid JSON at ${path} (${errorMessage(error)})`,
    );
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`${label}: expected a JSON object at ${path}`);
  }
  return parsed;
}

function exactScalarError(
  label: string,
  actual: unknown,
  expected: string,
): string | undefined {
  if (actual === expected) {
    return undefined;
  }
  return `${label}: expected ${JSON.stringify(expected)}, observed ${observedValue(actual)}`;
}

function validateFileMap(label: string, value: unknown): string[] {
  if (!isJsonObject(value)) {
    return [`${label}: expected an object, observed ${observedValue(value)}`];
  }

  const errors = exactKeyErrors(label, value, EXPECTED_FILE_NAMES);
  for (const [name, digest] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (typeof digest !== "string") {
      errors.push(
        `${label}.${name}: expected a digest string, observed ${observedValue(digest)}`,
      );
      continue;
    }
    if (!SHA256_DIGEST_PATTERN.test(digest)) {
      errors.push(
        `${label}.${name}: expected sha256 followed by 64 lowercase hexadecimal digits, observed ${JSON.stringify(digest)}`,
      );
    }
  }

  for (const name of EXPECTED_FILE_NAMES) {
    if (!Object.hasOwn(value, name)) {
      continue;
    }
    const expectedDigest =
      EXPECTED_FILE_DIGESTS[name as keyof typeof EXPECTED_FILE_DIGESTS];
    const actualDigest = value[name];
    if (actualDigest !== expectedDigest) {
      errors.push(
        `${label}.${name}: expected frozen digest ${expectedDigest}, observed ${observedValue(actualDigest)}`,
      );
    }
  }

  return errors;
}

function validateWrapperManifest(manifest: JsonObject): string[] {
  const errors = exactKeyErrors(
    "vendored wrapper manifest",
    manifest,
    EXPECTED_WRAPPER_KEYS,
  );
  const scalarPins = [
    ["protocol_version", EXPECTED_PROTOCOL_VERSION],
    ["fixture_profile_version", EXPECTED_FIXTURE_PROFILE_VERSION],
    ["generation_command", EXPECTED_GENERATION_COMMAND],
    ["upstream_repository", EXPECTED_UPSTREAM_REPOSITORY],
    ["upstream_commit", EXPECTED_UPSTREAM_COMMIT],
    ["upstream_manifest_sha256", EXPECTED_UPSTREAM_MANIFEST_SHA256],
  ] as const;

  for (const [field, expected] of scalarPins) {
    const error = exactScalarError(
      `vendored wrapper manifest.${field}`,
      manifest[field],
      expected,
    );
    if (error !== undefined) {
      errors.push(error);
    }
  }

  const upstreamManifestDigest = manifest.upstream_manifest_sha256;
  if (
    typeof upstreamManifestDigest === "string" &&
    !SHA256_DIGEST_PATTERN.test(upstreamManifestDigest)
  ) {
    errors.push(
      `vendored wrapper manifest.upstream_manifest_sha256: expected a canonical SHA-256 digest, observed ${JSON.stringify(upstreamManifestDigest)}`,
    );
  }

  errors.push(
    ...validateFileMap("vendored wrapper manifest.files", manifest.files),
  );
  return errors;
}

function regularFileBytes(path: string): Buffer | undefined {
  try {
    if (!lstatSync(path).isFile()) {
      return undefined;
    }
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function verifyVendoredProfile(): {
  errors: string[];
  manifest: JsonObject;
} {
  const errors: string[] = [];
  const manifestPath = resolve(vendoredFixtureDirectory, "manifest.json");
  let manifest: JsonObject = {};

  errors.push(
    ...exactDirectoryEntryErrors(
      "vendored fixture directory",
      vendoredFixtureDirectory,
      EXPECTED_DIRECTORY_ENTRIES,
    ),
  );

  if (regularFileBytes(manifestPath) === undefined) {
    errors.push(
      `vendored wrapper manifest: expected a readable regular file at ${manifestPath}`,
    );
  } else {
    try {
      manifest = readJsonObject(manifestPath, "vendored wrapper manifest");
      errors.push(...validateWrapperManifest(manifest));
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const declaredFiles = isJsonObject(manifest.files) ? manifest.files : {};
  for (const name of EXPECTED_FILE_NAMES) {
    const fixturePath = resolve(vendoredFixtureDirectory, name);
    const bytes = regularFileBytes(fixturePath);
    if (bytes === undefined) {
      errors.push(
        `vendored fixture ${name}: expected a readable regular file at ${fixturePath}`,
      );
      continue;
    }
    const actualDigest = sha256Digest(bytes);
    const expectedDigest =
      EXPECTED_FILE_DIGESTS[name as keyof typeof EXPECTED_FILE_DIGESTS];
    if (actualDigest !== expectedDigest) {
      errors.push(
        `vendored fixture ${name}: expected raw-byte digest ${expectedDigest}, observed ${actualDigest}`,
      );
    }

    const declaredDigest = declaredFiles[name];
    if (typeof declaredDigest === "string" && actualDigest !== declaredDigest) {
      errors.push(
        `vendored fixture ${name}: manifest declares ${declaredDigest}, raw bytes hash to ${actualDigest}`,
      );
    }
  }

  return { errors, manifest };
}

function stripCommandNewline(value: string): string {
  return value.replace(/(?:\r?\n)+$/, "");
}

function runLocalGit(
  checkoutDirectory: string,
  arguments_: readonly string[],
  failureLabel: string,
  errors: string[],
): string | undefined {
  try {
    return stripCommandNewline(
      execFileSync("git", ["-C", checkoutDirectory, ...arguments_], {
        encoding: "utf8",
        env: localGitEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    errors.push(`${failureLabel}: ${errorMessage(error)}`);
    return undefined;
  }
}

function normalizeRepositoryUrl(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function rawLocalOriginErrors(checkoutDirectory: string): string[] {
  const result = spawnSync(
    "git",
    [
      "-C",
      checkoutDirectory,
      "config",
      "--local",
      "--no-includes",
      "--null",
      "--get-all",
      "remote.origin.url",
    ],
    {
      encoding: "utf8",
      env: localGitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error !== undefined) {
    return [
      `upstream checkout raw local origin: unable to read remote.origin.url (${errorMessage(result.error)})`,
    ];
  }
  if (result.status === 1 && result.stdout.length === 0) {
    return [
      "upstream checkout raw local origin: expected exactly one remote.origin.url value, observed none",
    ];
  }
  if (result.status !== 0) {
    const detail = singleLine(result.stderr);
    return [
      `upstream checkout raw local origin: git config exited ${result.status ?? "without a status"}${detail.length > 0 ? ` (${detail})` : ""}`,
    ];
  }

  const values = result.stdout.split("\0");
  if (values.at(-1) === "") {
    values.pop();
  }
  if (values.length === 0) {
    return [
      "upstream checkout raw local origin: expected exactly one remote.origin.url value, observed none",
    ];
  }
  if (values.length !== 1) {
    return [
      `upstream checkout raw local origin: expected exactly one remote.origin.url value, observed ${values.length}`,
    ];
  }

  const rawOrigin = values[0];
  if (rawOrigin === undefined) {
    return [
      "upstream checkout raw local origin: expected exactly one remote.origin.url value, observed none",
    ];
  }
  const normalizedOrigin = normalizeRepositoryUrl(rawOrigin);
  if (normalizedOrigin !== EXPECTED_UPSTREAM_REPOSITORY) {
    return [
      `upstream checkout raw local origin: expected ${EXPECTED_UPSTREAM_REPOSITORY}, observed ${singleLine(normalizedOrigin)}`,
    ];
  }

  return [];
}

function validateUpstreamManifest(
  upstream: JsonObject,
  wrapper: JsonObject,
): string[] {
  const errors = exactKeyErrors(
    "upstream manifest",
    upstream,
    EXPECTED_UPSTREAM_MANIFEST_KEYS,
  );
  const scalarFields = [
    ["protocol_version", EXPECTED_PROTOCOL_VERSION],
    ["fixture_profile_version", EXPECTED_FIXTURE_PROFILE_VERSION],
    ["generation_command", EXPECTED_GENERATION_COMMAND],
  ] as const;

  for (const [field, expected] of scalarFields) {
    const pinError = exactScalarError(
      `upstream manifest.${field}`,
      upstream[field],
      expected,
    );
    if (pinError !== undefined) {
      errors.push(pinError);
    }
    if (upstream[field] !== wrapper[field]) {
      errors.push(
        `upstream manifest.${field}: expected wrapper value ${observedValue(wrapper[field])}, observed ${observedValue(upstream[field])}`,
      );
    }
  }

  errors.push(...validateFileMap("upstream manifest.files", upstream.files));
  if (isJsonObject(upstream.files) && isJsonObject(wrapper.files)) {
    for (const name of EXPECTED_FILE_NAMES) {
      if (upstream.files[name] !== wrapper.files[name]) {
        errors.push(
          `upstream manifest.files.${name}: expected wrapper value ${observedValue(wrapper.files[name])}, observed ${observedValue(upstream.files[name])}`,
        );
      }
    }
  }

  return errors;
}

function verifyUpstreamCheckout(
  checkoutDirectory: string,
  wrapper: JsonObject,
): string[] {
  const errors: string[] = [];
  const resolvedCheckout = resolve(checkoutDirectory);
  let realCheckout: string;

  try {
    if (!statSync(resolvedCheckout).isDirectory()) {
      return [`upstream checkout: expected a directory at ${resolvedCheckout}`];
    }
    realCheckout = realpathSync(resolvedCheckout);
  } catch (error) {
    return [
      `upstream checkout: path is missing or unreadable at ${resolvedCheckout} (${errorMessage(error)})`,
    ];
  }

  const gitRoot = runLocalGit(
    realCheckout,
    ["rev-parse", "--show-toplevel"],
    `upstream checkout: ${realCheckout} is not a local Git checkout root`,
    errors,
  );
  if (gitRoot === undefined) {
    return errors;
  }

  try {
    const realGitRoot = realpathSync(gitRoot);
    if (realGitRoot !== realCheckout) {
      errors.push(
        `upstream checkout root: expected ${realCheckout}, observed ${realGitRoot}`,
      );
    }
  } catch (error) {
    errors.push(
      `upstream checkout root: unable to resolve Git root ${gitRoot} (${errorMessage(error)})`,
    );
  }

  const head = runLocalGit(
    realCheckout,
    ["rev-parse", "HEAD"],
    "upstream checkout HEAD: unable to read local commit",
    errors,
  );
  if (head !== undefined && head !== EXPECTED_UPSTREAM_COMMIT) {
    errors.push(
      `upstream checkout HEAD: expected ${EXPECTED_UPSTREAM_COMMIT}, observed ${head}`,
    );
  }

  const origin = runLocalGit(
    realCheckout,
    ["remote", "get-url", "origin"],
    "upstream checkout origin: unable to read local origin",
    errors,
  );
  if (origin !== undefined) {
    const normalizedOrigin = normalizeRepositoryUrl(origin);
    if (normalizedOrigin !== EXPECTED_UPSTREAM_REPOSITORY) {
      errors.push(
        `upstream checkout origin: expected ${EXPECTED_UPSTREAM_REPOSITORY}, observed ${normalizedOrigin}`,
      );
    }
  }
  errors.push(...rawLocalOriginErrors(realCheckout));

  const upstreamFixtureDirectory = resolve(
    realCheckout,
    "contextgraph-conformance/fixtures/contextgraph-1.0-draft",
  );
  errors.push(
    ...exactDirectoryEntryErrors(
      "upstream fixture directory",
      upstreamFixtureDirectory,
      EXPECTED_DIRECTORY_ENTRIES,
    ),
  );

  const upstreamManifestPath = resolve(
    upstreamFixtureDirectory,
    "manifest.json",
  );
  const upstreamManifestBytes = regularFileBytes(upstreamManifestPath);
  if (upstreamManifestBytes === undefined) {
    errors.push(
      `upstream manifest: expected a readable regular file at ${upstreamManifestPath}`,
    );
  } else {
    const actualManifestDigest = sha256Digest(upstreamManifestBytes);
    if (actualManifestDigest !== EXPECTED_UPSTREAM_MANIFEST_SHA256) {
      errors.push(
        `upstream manifest raw digest: expected ${EXPECTED_UPSTREAM_MANIFEST_SHA256}, observed ${actualManifestDigest}`,
      );
    }
    if (
      typeof wrapper.upstream_manifest_sha256 === "string" &&
      actualManifestDigest !== wrapper.upstream_manifest_sha256
    ) {
      errors.push(
        `upstream manifest raw digest: wrapper declares ${wrapper.upstream_manifest_sha256}, observed ${actualManifestDigest}`,
      );
    }
    try {
      const upstreamManifest = readJsonObject(
        upstreamManifestPath,
        "upstream manifest",
      );
      errors.push(...validateUpstreamManifest(upstreamManifest, wrapper));
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  for (const name of EXPECTED_FILE_NAMES) {
    const upstreamBytes = regularFileBytes(
      resolve(upstreamFixtureDirectory, name),
    );
    const vendoredBytes = regularFileBytes(
      resolve(vendoredFixtureDirectory, name),
    );
    if (upstreamBytes === undefined) {
      errors.push(
        `upstream fixture ${name}: expected a readable regular file at ${resolve(upstreamFixtureDirectory, name)}`,
      );
      continue;
    }
    if (vendoredBytes === undefined) {
      errors.push(
        `vendored fixture ${name}: expected a readable regular file at ${resolve(vendoredFixtureDirectory, name)}`,
      );
      continue;
    }
    if (!upstreamBytes.equals(vendoredBytes)) {
      errors.push(
        `fixture byte parity ${name}: upstream and vendored payloads differ`,
      );
    }
  }

  return errors;
}

function main(): void {
  const { errors, manifest } = verifyVendoredProfile();
  const checkoutDirectory = process.env.CONTEXT_GRAPH_PROTOCOL_DIR;
  let verifiedCheckoutPath: string | undefined;

  if (
    errors.length === 0 &&
    checkoutDirectory !== undefined &&
    checkoutDirectory !== ""
  ) {
    errors.push(...verifyUpstreamCheckout(checkoutDirectory, manifest));
    if (errors.length === 0) {
      try {
        verifiedCheckoutPath = realpathSync(resolve(checkoutDirectory));
      } catch (error) {
        errors.push(
          `upstream checkout: unable to resolve verified path ${resolve(checkoutDirectory)} (${errorMessage(error)})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("Context Graph fixture drift check failed:");
    for (const error of errors) {
      console.error(`- ${singleLine(error)}`);
    }
    process.exitCode = 1;
    return;
  }

  if (checkoutDirectory === undefined || checkoutDirectory === "") {
    console.log(
      `Context Graph fixture profile ${EXPECTED_FIXTURE_PROFILE_VERSION}: validated ${EXPECTED_FILE_NAMES.length} vendored files offline.`,
    );
    return;
  }

  console.log(
    `Context Graph fixture profile ${EXPECTED_FIXTURE_PROFILE_VERSION}: matched ${EXPECTED_FILE_NAMES.length} files at commit ${EXPECTED_UPSTREAM_COMMIT} in ${verifiedCheckoutPath}.`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  resolve(entrypoint) === fileURLToPath(import.meta.url)
) {
  main();
}
