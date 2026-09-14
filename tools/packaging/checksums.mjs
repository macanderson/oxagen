#!/usr/bin/env node
/**
 * Write a `<file>.sha256` next to every release asset, in the one-line
 * `sha256sum` format (`<hex>  <basename>`) that `shasum -a 256 -c` and
 * `sha256sum -c` both verify, and that `stamp.mjs` reads back to fill the
 * Homebrew and Scoop templates.
 *
 *   node tools/packaging/checksums.mjs <dir | file> [...]
 *
 * A directory argument means every regular file in it except dotfiles and
 * existing `.sha256` files. Runs on every OS in the release matrix because
 * the runners disagree on which checksum tool they have.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `sha256sum` line for one asset. */
export function checksumLine(name, bytes) {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
}

/**
 * Parse `<hex>  <name>` lines (one file or many concatenated) into a
 * name → hex map. Tolerates the `*` binary marker `sha256sum -b` emits.
 */
export function parseChecksums(text) {
  const digests = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
    if (!match) throw new Error(`not a sha256sum line: ${raw}`);
    digests.set(match[2], match[1].toLowerCase());
  }
  return digests;
}

/** Every asset file under `target` (a file, or a directory's plain files). */
export function listAssets(target) {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target)
    .filter((name) => !name.startsWith(".") && !name.endsWith(".sha256"))
    .map((name) => join(target, name))
    .filter((path) => statSync(path).isFile());
}

export function writeChecksums(targets) {
  const written = [];
  for (const target of targets) {
    for (const file of listAssets(target)) {
      const out = `${file}.sha256`;
      writeFileSync(out, checksumLine(basename(file), readFileSync(file)));
      written.push(out);
    }
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: checksums.mjs <dir | file> [...]");
    process.exit(2);
  }
  for (const out of writeChecksums(targets)) console.log(`✔ ${out}`);
}
