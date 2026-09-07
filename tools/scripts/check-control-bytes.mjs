#!/usr/bin/env node
/**
 * check-control-bytes.mjs — no tracked text source may contain a raw control
 * byte.
 *
 * A NUL (or any other C0 control character that is not tab/newline/carriage
 * return) sitting literally in a `.ts` file makes git classify the file as
 * binary. Two things follow, both silent:
 *
 *   - `git diff` and `git show --stat` render `Bin 12440 -> 13546 bytes` with
 *     no line counts, so every change to that file lands unreviewed. A file
 *     can be rewritten end to end and the pull request shows one line.
 *   - ripgrep skips it. `rg -n "cacheOptions" packages/ai/src/generate-object.ts`
 *     reports a binary-file match and no lines, so the file is invisible to
 *     search — including the searches an agent runs to find its own callers.
 *
 * Five files on the structured-output, idempotency-key and search-dedup paths
 * had drifted into this state (#1416). The byte was deliberate every time — a
 * NUL is the right domain separator for a hash input — but written raw instead
 * of as the escape `\0`, which is the identical byte with none of the above.
 *
 * So this guard does not ban the byte; it bans the *spelling*. Write `\0` (or
 * `\\u0000`) in the literal and the hash is unchanged, the diff is reviewable,
 * and search works.
 *
 * Exit codes:
 *   0 — no raw control bytes in tracked text source.
 *   1 — one or more files carry one.
 *   2 — script error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Extensions whose contents a human reads and a reviewer diffs. Binary assets
 * (images, fonts, archives, lockfile caches) are full of control bytes by
 * construction and are deliberately not scanned — an allowlist rather than a
 * denylist, so a new binary format cannot quietly opt itself in.
 */
export const TEXT_EXTENSIONS = new Set([
  "cjs",
  "css",
  "graphql",
  "html",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "mts",
  "prisma",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
]);

/**
 * Tab (0x09), line feed (0x0a) and carriage return (0x0d) are the control
 * characters text is made of. Everything else below 0x20, plus DEL (0x7f), is
 * what this guard is looking for — with one exemption.
 *
 * ESC (0x1b) is allowed. It is the one control byte with a legitimate literal
 * use: a terminal-output fixture or a spec quoting an ANSI sequence contains
 * real ESCs, and unlike NUL it triggers neither git's binary heuristic (which
 * looks for NUL in the first 8000 bytes) nor ripgrep's, so it causes none of
 * the harm above. Banning it would fail this guard on three documents that are
 * doing nothing wrong, and a guard that cries wolf is a guard someone turns
 * off.
 */
export const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d, 0x1b]);

export function findControlBytes(contents) {
  const hits = [];
  let line = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const byte = contents[index];
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if (ALLOWED_CONTROL_BYTES.has(byte)) continue;
    if (byte < 0x20 || byte === 0x7f) {
      hits.push({ line, byte });
    }
  }
  return hits;
}

export function hasTextExtension(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function main() {
  const offenders = [];

  for (const path of trackedFiles()) {
    if (!hasTextExtension(path)) continue;
    let contents;
    try {
      contents = readFileSync(path);
    } catch {
      // A tracked path that is not readable here (a submodule gitlink, a file
      // removed from the working tree) is not this guard's business.
      continue;
    }
    const hits = findControlBytes(contents);
    if (hits.length > 0) offenders.push({ path, hits });
  }

  if (offenders.length === 0) {
    console.log(
      "check-control-bytes: no raw control bytes in tracked text source",
    );
    return 0;
  }

  console.error("Raw control bytes in tracked text source:\n");
  for (const { path, hits } of offenders) {
    for (const { line, byte } of hits) {
      const hex = byte.toString(16).padStart(2, "0");
      console.error(`  ${path}:${line}  0x${hex}`);
    }
  }
  console.error(
    "\nGit calls these files binary: their diffs render as `Bin` with no line" +
      "\ncounts, and ripgrep skips them. Write the escape instead — `\\0` for a" +
      "\nNUL — which is the same byte, reviewable and searchable.",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    console.error("check-control-bytes failed:", error);
    process.exit(2);
  }
}
