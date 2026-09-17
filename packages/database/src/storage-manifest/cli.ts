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

/**
 * The lines `--check` prints when the committed bytes differ from the
 * regenerated ones.
 *
 * Split out from `main` so the wording is testable, and because getting it
 * wrong costs more than it looks. `--check` compares BYTES, and a manifest has
 * two independent ways to differ: its body, and the `contentHash` field
 * recording that body. Reporting only one of them describes a file nobody has.
 *
 * The earlier version printed `contentHashOf(committed)` against the
 * regenerated hash, to avoid a stale recorded value reading as a match on a
 * file that had really drifted. That defeated the diagnostic in the opposite
 * case, which is the one that actually occurred: when the body is current and
 * only the recorded field is stale, both recomputed hashes are equal, so the
 * check printed two identical hashes under a DRIFT DETECTED banner and gave a
 * reader no way to tell a real difference from a bug in the check. It cost a
 * cutover a CI cycle.
 *
 * So both numbers are printed, and the two cases are named rather than left to
 * be inferred from them.
 */
export function driftReport(
  committed: string,
  regeneratedHash: string,
): string[] {
  const out = ["storage-manifest DRIFT DETECTED — committed file is stale."];
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(committed) as Record<string, unknown>;
  } catch {
    // An unparseable file has no body to hash and no recorded field to read.
    out.push("  committed file is not valid JSON.");
    out.push(`  regenerated contentHash: ${regeneratedHash}`);
    out.push("  Run `pnpm schema:manifest` and commit the result.");
    return out;
  }

  const recorded = typeof body.contentHash === "string" ? body.contentHash : "";
  const recomputed = contentHashOf(body);

  out.push(`  committed contentHash field:     ${recorded || "(absent)"}`);
  out.push(`  recomputed over committed body:  ${recomputed}`);
  out.push(`  regenerated contentHash:         ${regeneratedHash}`);

  if (recomputed === regeneratedHash) {
    out.push(
      "  The body is current; only the recorded contentHash field is stale.",
    );
  } else {
    out.push("  The body itself has drifted.");
  }
  out.push("  Run `pnpm schema:manifest` and commit the result.");
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
      for (const line of driftReport(committed, manifest.contentHash)) {
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
