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
 * The surfaces column of `docs/capabilities/_index.md` is held to the same
 * rule. Four rows had drifted from their contracts before this check read
 * the index (resolve_approval among them, #2950).
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

/**
 * A row of `docs/capabilities/_index.md`: the name cell, the contract link
 * cell, and the surfaces cell. The contract link's file name keys the row.
 */
const INDEX_ROW =
  /^\|[^|]*\|\s*\[([^\]]+\.ts)\]\([^)]*\)\s*\|\s*([^|]*?)\s*\|\s*$/;

/**
 * The surfaces each `_index.md` row names, keyed by contract file name. A
 * cell that reads `none` names an empty array.
 * @param {string} markdown
 * @returns {Map<string, string[]>}
 */
export function indexSurfaces(markdown) {
  const rows = new Map();
  for (const line of markdown.split("\n")) {
    const match = line.match(INDEX_ROW);
    if (!match) continue;
    const cell = match[2].trim();
    rows.set(
      match[1],
      cell === "none"
        ? []
        : cell
            .split(",")
            .map((s) => s.trim().replace(/`/g, ""))
            .filter(Boolean),
    );
  }
  return rows;
}

/**
 * The `_index.md` rows whose surfaces cell differs from the contract. A row
 * for a contract the manifest does not hold, and a contract with no row, are
 * out of scope, as they are for the doc pages.
 * @param {{ file: string, name: string, surfaces: string[] }[]} capabilities
 * @param {string} indexMarkdown
 * @returns {{ file: string, name: string, index: string[], contract: string[] }[]}
 */
export function findIndexMismatches(capabilities, indexMarkdown) {
  const rows = indexSurfaces(indexMarkdown);
  const mismatches = [];
  for (const cap of capabilities) {
    const index = rows.get(cap.file);
    if (index === undefined) continue;
    if ([...index].sort().join(",") !== [...cap.surfaces].sort().join(",")) {
      mismatches.push({
        file: cap.file,
        name: cap.name,
        index,
        contract: cap.surfaces,
      });
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
  const indexPath = join(DOCS_DIR, "_index.md");
  const indexMismatches = existsSync(indexPath)
    ? findIndexMismatches(capabilities, readFileSync(indexPath, "utf8"))
    : [];
  if (mismatches.length === 0 && indexMismatches.length === 0) {
    console.log(
      "check-capability-docs: every **Surfaces:** line and _index.md row matches its contract.",
    );
    return 0;
  }
  if (mismatches.length > 0) {
    console.error(
      "docs/capabilities **Surfaces:** lines that differ from the contract:\n",
    );
    for (const m of mismatches) {
      console.error(
        `  ${m.stem}.md (${m.name}): doc says [${m.doc.join(", ")}], contract declares [${m.contract.join(", ")}]`,
      );
    }
  }
  if (indexMismatches.length > 0) {
    console.error(
      "docs/capabilities/_index.md rows whose surfaces differ from the contract:\n",
    );
    for (const m of indexMismatches) {
      console.error(
        `  ${m.name} (${m.file}): index says [${m.index.join(", ") || "none"}], contract declares [${m.contract.join(", ") || "none"}]`,
      );
    }
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
