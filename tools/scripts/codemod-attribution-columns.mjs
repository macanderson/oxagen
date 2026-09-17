#!/usr/bin/env node
// codemod-attribution-columns.mjs — rename the audit-attribution identifiers
// on a branch that predates migration 20260915230000_attribution_columns_by_id.
//
//   created_by_user_id / createdByUserId  ->  created_by_id / createdById
//   updated_by_user_id / updatedByUserId  ->  updated_by_id / updatedById
//   deleted_by_user_id / deletedByUserId  ->  deleted_by_id / deletedById
//
// Run it from the repository root on a lane branch after rebasing onto
// app-rebuild, then review `git diff`. It rewrites every tracked text file
// except the migration history (a migration that already ran keeps the names
// it ran with — only a NOT-yet-merged migration should be edited, by hand),
// the retired drizzle archive, the generated storage manifest, dated audit
// records, and the static reference artifacts that were deleted with this
// change.
//
//   node tools/scripts/codemod-attribution-columns.mjs           # rewrite
//   node tools/scripts/codemod-attribution-columns.mjs --check   # list only
//
// Whole-word matches only, so `createdBy` (the resolved display name in the
// role contracts) and any external-record field such as a connector's
// `createdBy` are left alone.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RENAMES = [
  [/\bcreatedByUserId\b/g, "createdById"],
  [/\bupdatedByUserId\b/g, "updatedById"],
  [/\bdeletedByUserId\b/g, "deletedById"],
  [/\bcreated_by_user_id\b/g, "created_by_id"],
  [/\bupdated_by_user_id\b/g, "updated_by_id"],
  [/\bdeleted_by_user_id\b/g, "deleted_by_id"],
];

const EXCLUDED_PREFIXES = [
  "packages/database/atlas/migrations/",
  "packages/database/drizzle/",
  "packages/database/storage-manifest.json",
  "packages/tacho/dist-standalone/",
  "docs/audits/",
  "docs/reference/",
  "docs/erd/",
  "CHANGELOG.md",
  "releases/",
];

const checkOnly = process.argv.includes("--check");

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((p) => !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)));

const touched = [];
for (const path of tracked) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue; // a submodule entry or an unreadable path
  }
  if (text.includes("\0")) continue; // binary
  let next = text;
  for (const [pattern, replacement] of RENAMES) {
    next = next.replace(pattern, replacement);
  }
  if (next === text) continue;
  touched.push(path);
  if (!checkOnly) writeFileSync(path, next);
}

for (const path of touched) console.log(path);
console.error(
  `${checkOnly ? "would rewrite" : "rewrote"} ${touched.length} file(s)`,
);
process.exitCode = checkOnly && touched.length > 0 ? 1 : 0;
