#!/usr/bin/env tsx
/**
 * check-versions.ts: every manifest carries the root version.
 *
 *   pnpm check:versions          # exit 1 and name each file that drifts
 *   pnpm check:versions --fix    # write the root version into each of them
 *
 * The version is lockstep across the monorepo, whatever the language of the
 * manifest (`tools/scripts/lib/versions.ts` lists the kinds). `pnpm release:*`
 * writes them all at once; this check, in the `check:contracts` chain, is
 * what keeps a hand edit or a new package from splitting the number.
 */
import { argv, exit } from "node:process";
import { resolve } from "node:path";
import { setAllVersions, versionDrift } from "./lib/versions";

const ROOT = resolve(import.meta.dirname, "../..");
const fix = argv.includes("--fix");

const { version, manifests, drift } = versionDrift(ROOT);
if (drift.length === 0) {
  console.log(
    `check:versions: ${manifests.length} manifests all at ${version}.`,
  );
  exit(0);
}

if (fix) {
  for (const m of setAllVersions(ROOT, version))
    if (m.from !== version)
      console.log(`  ${m.from ?? "(none)"} → ${version}  ${m.file}`);
  console.log(`check:versions: ${drift.length} manifest(s) set to ${version}.`);
  exit(0);
}

console.error(
  `check:versions: root package.json is ${version}, but ${drift.length} manifest(s) differ:`,
);
for (const m of drift)
  console.error(
    `  ${m.file} (${m.kind}, ${m.name}): ${m.version ?? "no version"}`,
  );
console.error(
  "Run `pnpm check:versions --fix`, or `pnpm release:<patch|minor|major>` to bump everything together.",
);
exit(1);
