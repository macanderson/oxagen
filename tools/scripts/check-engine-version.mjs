#!/usr/bin/env node
/**
 * check-engine-version.mjs: every tracked file that names a `stella-serve`
 * image tag names the version the engine client is pinned to.
 *
 * `STELLA_SERVE_PINNED_VERSION` in
 * `packages/stella-engine-client/src/version.ts` is the engine's one version.
 * Every assistant run records it as its engine version, and
 * `tools/scripts/package-for-node.sh` reads it to name the image the node
 * runs. A file that cannot read TypeScript still has to write a tag down:
 * `docker-compose.dev.yml` defaults `STELLA_SERVE_IMAGE_TAG` for the local
 * engine. This guard holds every such literal to the pin, so a bump that
 * misses one fails `pnpm check:contracts`.
 *
 * The two drifted once. #2833 pinned the client at 0.9.411 and deployed the
 * 0.9.414 image, the first one Stella published. From then on every
 * assistant run recorded an engine version that was not running.
 *
 * Markdown is not scanned. An ADR or a spec records the version that was true
 * on its date, and a bump must not rewrite that record. A tag that is not a
 * version, such as `latest` or a shell variable, is not a pin and is not
 * checked.
 *
 * Exit codes:
 *   0: every tag literal matches the pin.
 *   1: a literal differs, or the pin cannot be read.
 *   2: script error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const VERSION_FILE = "packages/stella-engine-client/src/version.ts";

/**
 * The pin as `package-for-node.sh` reads it with sed. Both read the same
 * shape, so a line one of them cannot parse fails the other as well.
 */
const PIN = /^export const STELLA_SERVE_PINNED_VERSION = "([^"]*)";$/gm;

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * A version as an image tag spells it. It ends on a letter or digit, so a
 * sentence's closing period is not read as part of the tag.
 */
const VERSION = String.raw`(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z])?)`;

/**
 * The two ways a file writes a tag down. The first is an image reference,
 * `stella-serve:<version>`, or a shell or compose default inside one,
 * `stella-serve:${NAME:-<version>}`. The second gives the override variable a
 * literal value, in a shell default, an assignment, or a YAML or env entry.
 */
export const TAG_PATTERNS = [
  new RegExp(String.raw`stella-serve:(?:\$\{\w+:?-)?${VERSION}`, "g"),
  new RegExp(
    String.raw`STELLA_SERVE_IMAGE_TAG\s*(?::?-|[=:])\s*["']?${VERSION}`,
    "g",
  ),
];

/**
 * Where an image tag can be chosen: shell, compose and workflow YAML,
 * Terraform, JSON, TOML, env files, Dockerfiles, and scripts.
 */
export const SCANNED_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "cts",
  "hcl",
  "js",
  "json",
  "mjs",
  "mts",
  "sh",
  "tf",
  "tfvars",
  "toml",
  "ts",
  "yaml",
  "yml",
]);

/** The pinned version in `source`, or null unless it holds exactly one. */
export function readPinnedVersion(source) {
  const found = [...source.matchAll(PIN)].map((match) => match[1]);
  if (found.length !== 1 || !SEMVER.test(found[0])) return null;
  return found[0];
}

/**
 * Whether a tracked path can choose an image tag. Test files are skipped:
 * their fixtures name versions on purpose.
 */
export function isScanned(path) {
  if (/\.test\.[cm]?[jt]s$/.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/^Dockerfile(\..+)?$/.test(name) || name.endsWith(".Dockerfile")) {
    return true;
  }
  if (name === ".env" || name.startsWith(".env.")) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SCANNED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Every tag literal in `contents`, once per line, with its line number. */
export function findTags(contents) {
  const hits = [];
  contents.split("\n").forEach((text, index) => {
    const tags = new Set();
    for (const pattern of TAG_PATTERNS) {
      for (const match of text.matchAll(pattern)) tags.add(match[1]);
    }
    for (const tag of tags) hits.push({ line: index + 1, tag });
  });
  return hits;
}

/** The literals in `files` that differ from `pinned`. */
export function findDrift(files, pinned) {
  const offenders = [];
  for (const { path, contents } of files) {
    for (const hit of findTags(contents)) {
      if (hit.tag !== pinned) offenders.push({ path, ...hit });
    }
  }
  return offenders;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function main() {
  let source = "";
  try {
    source = readFileSync(join(repoRoot, VERSION_FILE), "utf8");
  } catch {
    // Reported below as an unreadable pin.
  }
  const pinned = readPinnedVersion(source);
  if (pinned === null) {
    console.error(
      `check-engine-version: cannot read the pin from ${VERSION_FILE}.\n\n` +
        "It must hold exactly one line of the form\n" +
        '  export const STELLA_SERVE_PINNED_VERSION = "<x>.<y>.<z>";\n' +
        "tools/scripts/package-for-node.sh reads that line to name the\n" +
        "image the node runs, and refuses to package the engine without it.",
    );
    return 1;
  }

  const files = [];
  for (const path of trackedFiles()) {
    if (!isScanned(path)) continue;
    try {
      files.push({
        path,
        contents: readFileSync(join(repoRoot, path), "utf8"),
      });
    } catch {
      // A tracked path that is not on disk here, such as one outside a
      // sparse checkout, is not this guard's business.
    }
  }

  const offenders = findDrift(files, pinned);
  if (offenders.length === 0) {
    console.log(
      `check-engine-version: every stella-serve tag is ${pinned}, the pin in ${VERSION_FILE}`,
    );
    return 0;
  }

  console.error(
    `check-engine-version: stella-serve tags that differ from the pin, ${pinned}:\n`,
  );
  for (const { path, line, tag } of offenders) {
    console.error(`  ${path}:${line}  ${tag}`);
  }
  console.error(
    `\nSet each to ${pinned}, or bump ${VERSION_FILE} if the tag is the` +
      "\nnew version. Every assistant run records the pin as its engine" +
      "\nversion, so a tag that differs makes the run ledger name an engine" +
      "\nthat is not running. packages/stella-engine-client/README.md has" +
      "\nthe bump steps.",
  );
  return 1;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  try {
    process.exit(main());
  } catch (error) {
    console.error("check-engine-version failed:", error);
    process.exit(2);
  }
}
