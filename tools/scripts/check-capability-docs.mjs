#!/usr/bin/env node
/**
 * check-capability-docs.mjs — the `**Surfaces:**` line of each
 * `docs/capabilities/<stem>.md` names the same surfaces as the contract in
 * `packages/oxagen/src/contracts/<stem>.ts`.
 *
 * The docs are hand-written and `pnpm docs:schemas` regenerates only the
 * JSON next to them, so a doc can promise a surface the contract refuses
 * (PR #3014 shipped five). The manifest is the parsed view of the contract
 * files; `pnpm check:manifest` rewrites it in the same CI step this runs in.
 *
 * A doc without the line, and a capability without a doc, are out of scope
 * here: `check_manifest.mjs` tracks the `docs` layer.
 *
 * Exit codes: 0 every present line matches; 1 a mismatch; 2 script error.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MANIFEST = join(ROOT, "packages/oxagen/capabilities.manifest.json");
const DOCS_DIR = join(ROOT, "docs/capabilities");

const SURFACES_LINE = /^\*\*Surfaces:\*\*[ \t]*(.*)$/m;

/**
 * The surfaces a doc's `**Surfaces:**` line names, or null when the doc has
 * no such line. A line that starts with `none` names an empty array; the
 * rest of that line may explain why.
 * @param {string} markdown
 * @returns {string[] | null}
 */
export function docSurfaces(markdown) {
  const match = markdown.match(SURFACES_LINE);
  if (!match) return null;
  const line = match[1].trim();
  if (/^none\b/.test(line)) return [];
  return line
    .split(",")
    .map((s) => s.trim().replace(/`/g, ""))
    .filter(Boolean);
}

/**
 * @param {{ file: string, name: string, surfaces: string[] }[]} capabilities
 * @param {(stem: string) => string | null} readDoc
 * @returns {{ stem: string, name: string, doc: string[], contract: string[] }[]}
 */
export function findMismatches(capabilities, readDoc) {
  const mismatches = [];
  for (const cap of capabilities) {
    const stem = cap.file.replace(/\.ts$/, "");
    const markdown = readDoc(stem);
    if (markdown === null) continue;
    const doc = docSurfaces(markdown);
    if (doc === null) continue;
    const contract = [...cap.surfaces].sort();
    if ([...doc].sort().join(",") !== contract.join(",")) {
      mismatches.push({ stem, name: cap.name, doc, contract: cap.surfaces });
    }
  }
  return mismatches;
}

function main() {
  const { capabilities } = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const mismatches = findMismatches(capabilities, (stem) => {
    const path = join(DOCS_DIR, `${stem}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  });
  if (mismatches.length === 0) {
    console.log(
      "check-capability-docs: every **Surfaces:** line matches its contract.",
    );
    return 0;
  }
  console.error(
    "docs/capabilities **Surfaces:** lines that differ from the contract:\n",
  );
  for (const m of mismatches) {
    console.error(
      `  ${m.stem}.md (${m.name}): doc says [${m.doc.join(", ")}], contract declares [${m.contract.join(", ")}]`,
    );
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    console.error("check-capability-docs failed:", error);
    process.exit(2);
  }
}
