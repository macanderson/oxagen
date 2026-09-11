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

function summarize(json: string): string {
  const manifest = JSON.parse(json) as StorageManifest;
  const s = manifestSummary(manifest);
  const byStore = Object.entries(s.tablesByStore)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  return [
    `contentHash: ${manifest.contentHash}`,
    `domains: ${s.domains}  tables: ${s.tables}  stores: ${s.stores}  capabilities: ${s.capabilities}`,
    `tables by store: ${byStore}`,
  ].join("\n");
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
      console.error(
        "storage-manifest DRIFT DETECTED — committed file is stale.",
      );
      const committedManifest = JSON.parse(committed) as StorageManifest;
      // Recompute over the committed body rather than printing its recorded
      // `contentHash` field: a hand-edited manifest carries a hash of the
      // content it used to have, so the recorded value can match the
      // regenerated one on a file that has genuinely drifted — two identical
      // hashes under a DRIFT DETECTED banner read as a bug in the check.
      console.error(
        `  committed contentHash: ${contentHashOf(
          committedManifest as unknown as Record<string, unknown>,
        )}`,
      );
      console.error(`  regenerated contentHash: ${manifest.contentHash}`);
      console.error("  Run `pnpm schema:manifest` and commit the result.");
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
