#!/usr/bin/env node
/**
 * Every ADR file in `docs/adr/` has an entry in `docs/adr/README.md`, every
 * ADR link in that index points at a file that exists, and no two ADR files
 * share a number.
 *
 * The README is how a reader finds a decision. Nothing checked it, so an ADR
 * could merge without an index entry and sit unfound, and a renamed ADR could
 * leave the index linking to nothing (#2978).
 *
 * An ADR counts as indexed when the README links to its file name. A bare
 * `ADR-043` in prose does not count, because another entry can mention an id
 * in passing without indexing it.
 *
 * Two branches cut from the same main each take the next free number, and
 * both index cleanly, so the index check alone let two ADR-182s merge. A
 * reference such as `(ADR-182)` then names two decisions.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ADR_FILE = /^ADR-\d+-.+\.md$/;
const ADR_LINK = /\]\((?:\.\/)?(ADR-\d+-[^)#\s]+\.md)(?:#[^)]*)?\)/g;

/** The ADR file names that the README links to. */
export function indexedFiles(readmeText) {
  const linked = new Set();
  for (const match of readmeText.matchAll(ADR_LINK)) linked.add(match[1]);
  return linked;
}

/** The ADR files that have no link in the README, sorted. */
export function missingFromIndex(adrFileNames, readmeText) {
  const linked = indexedFiles(readmeText);
  return adrFileNames
    .filter((name) => ADR_FILE.test(name) && !linked.has(name))
    .sort();
}

/** The README's ADR links whose target file does not exist, sorted. */
export function deadIndexLinks(adrFileNames, readmeText) {
  const present = new Set(adrFileNames);
  return [...indexedFiles(readmeText)]
    .filter((name) => !present.has(name))
    .sort();
}

/** The ADR numbers that more than one file claims, each with its files, sorted. */
export function duplicateNumbers(adrFileNames) {
  const byNumber = new Map();
  for (const name of adrFileNames) {
    if (!ADR_FILE.test(name)) continue;
    const number = name.slice(0, name.indexOf("-", "ADR-".length));
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  return [...byNumber]
    .filter(([, names]) => names.length > 1)
    .map(([number, names]) => ({ number, files: names.sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const adrDir = join(repoRoot, "docs", "adr");
  const files = readdirSync(adrDir).filter((name) => ADR_FILE.test(name));
  const readme = readFileSync(join(adrDir, "README.md"), "utf8");
  const missing = missingFromIndex(files, readme);
  const dead = deadIndexLinks(files, readme);
  const duplicates = duplicateNumbers(files);
  if (missing.length > 0 || dead.length > 0 || duplicates.length > 0) {
    const lines = [
      ...missing.map((name) => `  not indexed: docs/adr/${name}`),
      ...dead.map((name) => `  dead link:   docs/adr/README.md -> ${name}`),
      ...duplicates.map(
        ({ number, files: names }) =>
          `  duplicate:   ${number} is claimed by ${names.join(", ")}`,
      ),
    ];
    console.error(
      "check-adr-index: docs/adr/README.md is out of step with docs/adr/.\n\n" +
        `${lines.join("\n")}\n\n` +
        "Add a line `- [ADR-NNN](./<file>.md) <title>` under the right heading\n" +
        "for each unindexed ADR, and fix or remove each dead link (#2978).\n" +
        "Renumber a duplicate to the next free number, and its references with it.",
    );
    process.exit(1);
  }
  console.log(
    `check-adr-index: all ${files.length} ADRs are indexed in docs/adr/README.md.`,
  );
}
