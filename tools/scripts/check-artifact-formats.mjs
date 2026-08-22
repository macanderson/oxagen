#!/usr/bin/env node
/**
 * check-artifact-formats.mjs — enforce the TOML hard cutover for agent
 * artifacts.
 *
 * Oxagen agents, skills, and slash commands are canonical TOML only. Exactly
 * one component is still allowed to understand Markdown/YAML-frontmatter
 * artifacts: the one-way migration converter that lifts pre-cutover managed
 * skill rows into TOML. This guard fails the build when a *normal* loader,
 * scaffold, or a piece of *live* documentation reintroduces the Markdown-era
 * formats.
 *
 * What it does NOT do: police prose in dated, explicitly historical documents
 * (ADRs, archived specs, superpowers plans). Rewriting history is not the goal;
 * preventing regression is.
 *
 * Exit codes:
 *   0 — no legacy artifact formats outside the allowlist.
 *   1 — one or more violations.
 *   2 — script error.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());

/**
 * Legacy markers. Each is a format the runtime must never learn to read again.
 * Kept deliberately narrow: these are the exact spellings the pre-TOML system
 * used, so a hit is a real regression rather than an incidental word match.
 */
export const PATTERNS = [
  { re: /\bSKILL\.md\b/, label: "SKILL.md (legacy skill manifest)" },
  { re: /\.skill\.md\b/, label: ".skill.md (legacy skill file)" },
  { re: /\bskillMd\b/, label: "skillMd (legacy field name)" },
  { re: /\bYAML frontmatter\b/i, label: "YAML frontmatter (legacy format)" },
];

/**
 * Roots that must stay TOML-only. Source roots cover the normal loaders,
 * scaffolds, handlers, and contracts; doc roots cover live customer-facing and
 * reference documentation.
 */
const SCAN = [
  { dir: "packages/skills/src", exts: [".ts"] },
  { dir: "packages/handlers/src", exts: [".ts"] },
  { dir: "packages/agent-artifacts/src", exts: [".ts"] },
  { dir: "packages/oxagen/src/contracts", exts: [".ts"] },
  { dir: "docs", exts: [".md"] },
  { dir: "apps/docs/content", exts: [".md", ".mdx"] },
];

/**
 * Explicitly allowlisted paths, each with the reason it is exempt. Prefixes
 * ending in `/` exempt a directory; anything else must match a file exactly.
 *
 * Every entry is enumerated on purpose — no broad globs — so that adding an
 * exemption is a visible, reviewable decision.
 */
export const ALLOWLIST = [
  // --- The one component that reads foreign formats. ---
  {
    path: "packages/handlers/src/skill-legacy-migration.ts",
    reason:
      "one-way converter for pre-cutover managed skill rows; the only server-side legacy reader",
  },

  // --- Explicitly historical documentation. Dated; not live guidance. ---
  {
    path: "docs/adr/",
    reason: "ADRs are immutable decision records predating the cutover",
  },
  {
    path: "docs/specs/",
    reason: "dated/auto-mined spec snapshots; regenerated, not hand-edited",
  },
  {
    path: "docs/superpowers/",
    reason: "implementation plans and design docs for the cutover itself",
  },
  {
    path: "apps/docs/content/docs/specs-and-plans/",
    reason: "archived specs, each stamped with an audit status and date",
  },
];

/** Test files legitimately assert that legacy formats are *ignored*. */
export function isTestFile(relPath) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(relPath) ||
    relPath.split(sep).includes("__tests__") ||
    relPath.split(sep).includes("fixtures")
  );
}

export function allowlistEntryFor(relPath) {
  const normalized = relPath.split(sep).join("/");
  return ALLOWLIST.find((entry) =>
    entry.path.endsWith("/")
      ? normalized.startsWith(entry.path)
      : normalized === entry.path,
  );
}

function walk(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, exts, out);
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan one file's content. Returns the violations it contains — empty when the
 * path is allowlisted, is a test file, or contains no legacy markers.
 *
 * Pure: takes content rather than reading it, so the rule set is unit-testable
 * without touching the filesystem.
 */
export function scanContent(relPath, content) {
  const normalized = relPath.split(sep).join("/");
  if (allowlistEntryFor(normalized)) return [];
  if (isTestFile(normalized)) return [];

  const violations = [];
  content.split("\n").forEach((line, index) => {
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        violations.push({
          file: normalized,
          line: index + 1,
          label,
          text: line.trim().slice(0, 120),
        });
      }
    }
  });
  return violations;
}

export function main() {
  const violations = [];

  for (const { dir, exts } of SCAN) {
    const absolute = join(ROOT, dir);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;

    for (const file of walk(absolute, exts, [])) {
      const relPath = relative(ROOT, file);
      violations.push(...scanContent(relPath, readFileSync(file, "utf8")));
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n✖ ${violations.length} legacy agent-artifact format reference(s) found.\n`,
    );
    console.error(
      "Oxagen agents, skills, and slash commands are canonical TOML only.\n" +
        "Normal loaders, scaffolds, and live documentation must not reintroduce\n" +
        "Markdown or YAML-frontmatter artifact formats.\n",
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.label}`);
      console.error(`    ${v.text}`);
    }
    console.error(
      "\nIf this reference is legitimate — the one-way migration converter, or an\n" +
        "explicitly historical document — add an enumerated entry with a reason to\n" +
        "ALLOWLIST in tools/scripts/check-artifact-formats.mjs.\n",
    );
    process.exit(1);
  }

  console.log(
    "✓ agent artifacts are TOML-only outside the migration converter",
  );
}

// Only run when executed directly, so tests can import the rule set.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`check-artifact-formats: ${error.message}`);
    process.exit(2);
  }
}
