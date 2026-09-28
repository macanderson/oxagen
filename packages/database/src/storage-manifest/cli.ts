#!/usr/bin/env tsx
// CLI entry for the storage-manifest generator (root script: schema:manifest).
//
//   pnpm schema:manifest            regenerate + write the committed manifest,
//                                   print the content hash + summary counts.
//   pnpm schema:manifest:check      drift check: regenerate in-memory and exit 1
//                                   with a hash summary if the committed file is
//                                   stale (does not write).
//
// Determinism is the whole point: --check compares the freshly generated
// canonical bytes against the committed file byte-for-byte, so any drift in an
// input (a new table, a renamed column, an added capability) is caught.
//
// --check runs in `pnpm gate`, `pnpm gate:full` and the pipeline `checks` job.
// It did not until #2823, and the committed manifest had by then missed the
// eight `tacho.*` tables migration 20260908120000 added: adding a table or a
// capability without re-running `pnpm schema:manifest` landed a stale manifest
// with every check green.
//
// The manifest commits no content hash and no per-store table count (ADR-216).
// The summary below computes both from the file it reads. Committed, each was
// a line that every table- or capability-adding branch rewrote, so two such
// branches always conflicted, and keeping one side's value left a manifest
// that disagreed with its own body (#3691, #3233).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildManifest, manifestSummary } from "./generate";
import { canonicalJson, contentHashOf } from "./canonical-json";
import type { StorageManifest } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the committed manifest. Lives at the database package root
 * (packages/database/storage-manifest.json) alongside drizzle.config.ts.
 */
export const MANIFEST_PATH = resolve(
  join(HERE, "..", "..", "storage-manifest.json"),
);

/** Repository-relative path, for messages a reader acts on. */
const MANIFEST_DISPLAY_PATH = "packages/database/storage-manifest.json";

function summarize(json: string): string {
  const manifest = JSON.parse(json) as StorageManifest;
  const s = manifestSummary(manifest);
  const byStore = Object.entries(s.tablesByStore)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  return [
    `contentHash: ${contentHashOf(manifest)}`,
    `domains: ${s.domains}  tables: ${s.tables}  stores: ${s.stores}  capabilities: ${s.capabilities}`,
    `tables by store: ${byStore}`,
  ].join("\n");
}

/** Where a committed file first departs from its regenerated form. */
export interface FirstDifference {
  /** 1-based line number. */
  line: number;
  /** The committed line, or null when the committed file ends first. */
  committed: string | null;
  /** The regenerated line, or null when the regenerated file ends first. */
  regenerated: string | null;
}

/**
 * The first line at which two texts differ, or null when they are equal.
 *
 * `tools/scripts/lib/capability-schema-docs.ts` has the same function for the
 * capability schema docs. It is repeated rather than shared because this
 * package cannot import from `tools/`, and nine lines do not earn a package.
 */
export function firstDifference(
  committed: string,
  regenerated: string,
): FirstDifference | null {
  if (committed === regenerated) return null;
  const a = committed.split("\n");
  const b = regenerated.split("\n");
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) {
      return {
        line: i + 1,
        committed: a[i] ?? null,
        regenerated: b[i] ?? null,
      };
    }
  }
  return { line: length, committed: null, regenerated: null };
}

/**
 * A committed body without the scalars ADR-216 stopped committing, so a file
 * that still records them hashes the same as its content.
 */
function withoutDerivedScalars(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { contentHash: _hash, ...rest } = body;
  if (Array.isArray(rest.stores)) {
    rest.stores = rest.stores.map((store: unknown) => {
      if (store === null || typeof store !== "object") return store;
      const { tableCount: _count, ...kept } = store as Record<string, unknown>;
      return kept;
    });
  }
  return rest;
}

function carriesDerivedScalars(body: Record<string, unknown>): boolean {
  if ("contentHash" in body) return true;
  return (
    Array.isArray(body.stores) &&
    body.stores.some(
      (store: unknown) =>
        store !== null && typeof store === "object" && "tableCount" in store,
    )
  );
}

function showLine(line: string | null): string {
  return line === null ? "(end of file)" : JSON.stringify(line);
}

/**
 * The lines `--check` prints when the committed bytes differ from the
 * regenerated ones.
 *
 * Split out from `main` so the wording is testable. The report names the
 * file, the content hash of each side, and the first line where they differ
 * with both values, so a reader can tell at once whether the manifest is
 * behind the schema or was resolved by keeping one side of a merge.
 *
 * An earlier version printed a recorded `contentHash` field beside a
 * recomputed one, and once printed two identical hashes under a DRIFT
 * DETECTED banner, which cost a cutover a CI cycle. The field is gone
 * (ADR-216), so the two numbers are now always the committed content and the
 * regenerated content, and the case where only the form differs is named
 * rather than left to be inferred.
 */
export function driftReport(
  committed: string,
  regenerated: string,
  file: string = MANIFEST_DISPLAY_PATH,
): string[] {
  const out = [`storage-manifest DRIFT DETECTED — ${file} is stale.`];
  const regeneratedHash = contentHashOf(
    JSON.parse(regenerated) as Record<string, unknown>,
  );
  const difference = firstDifference(committed, regenerated);
  const differenceLines =
    difference === null
      ? []
      : [
          `  first difference at line ${difference.line}:`,
          `    committed:   ${showLine(difference.committed)}`,
          `    regenerated: ${showLine(difference.regenerated)}`,
        ];
  const fix =
    "  Run `pnpm schema:manifest` and commit the result. After a merge, regenerate from the merged tree; do not keep either side's copy.";

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(committed) as Record<string, unknown>;
  } catch {
    // An unparseable file, such as one holding merge markers, has no content
    // to hash, but its first differing line still shows what went wrong.
    out.push("  committed file is not valid JSON.");
    out.push(`  regenerated content hash:  ${regeneratedHash}`);
    out.push(...differenceLines, fix);
    return out;
  }

  const committedHash = contentHashOf(withoutDerivedScalars(body));
  out.push(`  committed content hash:    ${committedHash}`);
  out.push(`  regenerated content hash:  ${regeneratedHash}`);
  out.push(...differenceLines);

  if (committedHash !== regeneratedHash) {
    out.push("  The content itself has drifted.");
  } else if (carriesDerivedScalars(body)) {
    out.push(
      "  The content is current, but the file still records contentHash or stores[].tableCount, which ADR-216 stopped committing.",
    );
  } else {
    out.push("  The content is current; only its formatting differs.");
  }
  out.push(fix);
  return out;
}

function main(): void {
  const check = process.argv.includes("--check");
  const manifest = buildManifest();
  const json = canonicalJson(manifest);

  if (check) {
    if (!existsSync(MANIFEST_PATH)) {
      console.error(
        `storage-manifest drift: ${MANIFEST_PATH} does not exist. Run \`pnpm schema:manifest\`.`,
      );
      process.exit(1);
    }
    const committed = readFileSync(MANIFEST_PATH, "utf8");
    if (committed !== json) {
      for (const line of driftReport(committed, json)) {
        console.error(line);
      }
      process.exit(1);
    }
    console.log("storage-manifest is up to date.");
    console.log(summarize(json));
    return;
  }

  writeFileSync(MANIFEST_PATH, json);
  console.log(`Wrote ${MANIFEST_PATH}`);
  console.log(summarize(json));
}

// Run only when executed directly, so importing MANIFEST_PATH from the barrel
// (or a test) never triggers a write. pathToFileURL — not `file://` + path —
// because manual concatenation mis-encodes a checkout path containing a space,
// `#` or `?`, which would make this comparison fail and silently no-op the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
