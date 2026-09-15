#!/usr/bin/env node
/**
 * Fill the package-manager templates for one desktop release.
 *
 *   node tools/packaging/stamp.mjs --version 2.1.1 --sums <dir> --out <dir>
 *
 * `--sums` is a directory of the `<asset>.sha256` files `checksums.mjs`
 * wrote (download them from the `desktop-v<version>` release first); `--out`
 * receives `homebrew/oxagen.rb`, `homebrew/tacho.rb` and `scoop/oxagen.json`
 * with every token replaced, ready to commit to the tap and the bucket.
 *
 * Tokens, in the order they are expanded:
 *   {{version}}            the release version, without the `desktop-v` prefix
 *   {{sha256:<asset>}}     the digest of that release asset; `<asset>` may
 *                          itself contain {{version}}
 *
 * A directive line, `# stamp: <text>` (or `// stamp:`), replaces the line
 * after it with `<text>`; a run of consecutive directives replaces the one
 * line after the run with their texts, one per line. The cask uses it to
 * keep `sha256 :no_check` — the only honest value while builds are unsigned
 * and the checked-in file has no digests — and still say exactly what the
 * tap job turns it into.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChecksums } from "./checksums.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The three templates, relative to this directory. */
export const TEMPLATES = [
  "homebrew/oxagen.rb",
  "homebrew/tacho.rb",
  "scoop/oxagen.json",
];

const DIRECTIVE = /^(\s*)(?:#|\/\/)\s*stamp: ?(.*?)\s*$/;

/**
 * Apply the `# stamp:` directives: a run of directive lines and the one line
 * after it collapse into the directives' texts, each at its own indentation.
 */
export function applyDirectives(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!DIRECTIVE.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    while (i < lines.length && DIRECTIVE.test(lines[i])) {
      const [, indent, body] = DIRECTIVE.exec(lines[i]);
      out.push(`${indent}${body}`);
      i += 1;
    }
    // `i` now sits on the line the run replaces; the loop's increment skips it.
    if (i >= lines.length) {
      throw new Error("a stamp directive needs a line after it to replace");
    }
  }
  return out.join("\n");
}

/**
 * Replace every token in `text`. `digests` maps an asset file name to its
 * hex digest; a token naming an asset with no digest is an error, because a
 * template that silently keeps `{{sha256:…}}` would install nothing.
 */
export function stamp(text, { version, digests }) {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`not a release version: ${version}`);
  }
  const withVersion = applyDirectives(text).replaceAll("{{version}}", version);
  return withVersion.replace(/\{\{sha256:([^}]+)\}\}/g, (_, asset) => {
    const digest = digests.get(asset);
    if (digest === undefined) {
      throw new Error(`no .sha256 for release asset ${asset}`);
    }
    return digest;
  });
}

/** Read every `*.sha256` in `dir` into one asset → digest map. */
export function readDigests(dir) {
  const digests = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sha256")) continue;
    for (const [asset, hex] of parseChecksums(
      readFileSync(join(dir, name), "utf8"),
    )) {
      digests.set(asset, hex);
    }
  }
  return digests;
}

export function stampAll({ version, sums, out }) {
  const digests = readDigests(sums);
  const written = [];
  for (const template of TEMPLATES) {
    const rendered = stamp(readFileSync(join(here, template), "utf8"), {
      version,
      digests,
    });
    const target = join(out, template);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    written.push(target);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    args.set(process.argv[i], process.argv[i + 1]);
  }
  const version = args.get("--version");
  const sums = args.get("--sums");
  const out = args.get("--out");
  if (!version || !sums || !out) {
    console.error(
      "usage: stamp.mjs --version <x.y.z> --sums <dir of .sha256> --out <dir>",
    );
    process.exit(2);
  }
  for (const file of stampAll({
    version,
    sums: resolve(sums),
    out: resolve(out),
  })) {
    console.log(`✔ ${file}`);
  }
}
