/**
 * Per-repo procedural priors (F8).
 *
 * Pure store and render module for repo-specific knowledge: test invocation,
 * layout, conventions, and accrued pitfalls. Persisted as JSON files in a
 * content-addressed directory (~/.oxagen/repo-priors/<slug>.json).
 *
 * No I/O side effects beyond fs read/write. No external deps beyond node:fs
 * and node:path. No `any` (TS 6). Graceful degradation on missing or corrupt
 * files (never throws). Atomic writes via temporary file + rename.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// ── Interface ──────────────────────────────────────────────────────────────

/**
 * Procedural knowledge for a repository.
 *
 * All fields are procedural only: how to run tests, where code lives,
 * patterns and traps observed. Never issue-specific solutions or hidden-test
 * content. Benchmark legality enforced by lintPriorLegality.
 */
export interface RepoPrior {
  /** Repository identifier, e.g. "django/django". */
  repo: string;
  /** Test invocation command, e.g. "./tests/runtests.py <label>". */
  testInvocation: string;
  /** How to find the test for a module, e.g. "tests/test_<module>.py". */
  testDiscovery: string;
  /** ≤5 bullets: where things live in the repo (src/, tests/, etc.). */
  layout: string[];
  /** ≤5 bullets: patterns that matter (naming, structure, conventions). */
  conventions: string[];
  /** ≤10 bullets: accrued traps ("MAX_NUM_FORMS=0 means unlimited"). */
  pitfalls: string[];
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** Count of source runs that contributed to this prior. */
  sourceRuns: number;
}

// ── Slug mapping ───────────────────────────────────────────────────────────

/**
 * Map a repository identifier to a filesystem slug.
 * Replaces "/" with "__" (e.g. "django/django" → "django__django").
 */
function repoToSlug(repo: string): string {
  return repo.replace(/\//g, "__");
}

// ── Load ───────────────────────────────────────────────────────────────────

/**
 * Load a prior from disk.
 *
 * Returns null if the file is missing, JSON is invalid, or the shape is
 * invalid (e.g. repo field doesn't match, arrays aren't string arrays).
 * Never throws.
 *
 * On successful load, truncates arrays to their documented caps:
 * layout ≤5, conventions ≤5, pitfalls ≤10.
 */
export function loadPrior(baseDir: string, repo: string): RepoPrior | null {
  const slug = repoToSlug(repo);
  const filePath = join(baseDir, `${slug}.json`);

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    // File missing or unreadable.
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Invalid JSON.
    return null;
  }

  // Validate shape.
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Validate required fields.
  if (typeof obj.repo !== "string" || obj.repo !== repo) {
    return null;
  }
  if (typeof obj.testInvocation !== "string") {
    return null;
  }
  if (typeof obj.testDiscovery !== "string") {
    return null;
  }
  if (
    !Array.isArray(obj.layout) ||
    !obj.layout.every((x) => typeof x === "string")
  ) {
    return null;
  }
  if (
    !Array.isArray(obj.conventions) ||
    !obj.conventions.every((x) => typeof x === "string")
  ) {
    return null;
  }
  if (
    !Array.isArray(obj.pitfalls) ||
    !obj.pitfalls.every((x) => typeof x === "string")
  ) {
    return null;
  }
  if (typeof obj.updatedAt !== "string") {
    return null;
  }
  if (typeof obj.sourceRuns !== "number" || !Number.isInteger(obj.sourceRuns)) {
    return null;
  }

  // Truncate arrays to caps.
  const layout = (obj.layout as string[]).slice(0, 5);
  const conventions = (obj.conventions as string[]).slice(0, 5);
  const pitfalls = (obj.pitfalls as string[]).slice(0, 10);

  return {
    repo,
    testInvocation: obj.testInvocation,
    testDiscovery: obj.testDiscovery,
    layout,
    conventions,
    pitfalls,
    updatedAt: obj.updatedAt,
    sourceRuns: obj.sourceRuns,
  };
}

// ── Save ───────────────────────────────────────────────────────────────────

/**
 * Save a prior to disk atomically.
 *
 * Creates baseDir if needed. Writes to a temporary file then renames it
 * to avoid partial writes. Never throws.
 */
export function savePrior(baseDir: string, prior: RepoPrior): void {
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch {
    // Ignore mkdir errors (race or permission); write will fail if needed.
  }

  const slug = repoToSlug(prior.repo);
  const filePath = join(baseDir, `${slug}.json`);
  const tmpPath = `${filePath}.tmp`;

  try {
    const json = JSON.stringify(prior, null, 2);
    writeFileSync(tmpPath, json, "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    // Ignore write/rename errors; no throw contract.
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

/**
 * Render a prior as a markdown block.
 *
 * Format: "## Repo prior: <repo>" header, followed by sections for test
 * invocation, test discovery, layout, conventions, and pitfalls.
 *
 * Hard cap: 2000 characters. Over the cap the whole pitfalls section is
 * dropped first; if that is still not enough the tail is clipped, which eats
 * conventions and then layout. The header, testInvocation, and testDiscovery
 * sit at the head and always survive.
 *
 * Returns the rendered block, possibly truncated.
 */
export function renderPrior(prior: RepoPrior): string {
  const lines: string[] = [];

  // Header.
  lines.push(`## Repo prior: ${prior.repo}`);
  lines.push("");

  // Test invocation (never truncated).
  lines.push("**Test invocation:**");
  lines.push(prior.testInvocation);
  lines.push("");

  // Test discovery.
  lines.push("**Test discovery:**");
  lines.push(prior.testDiscovery);
  lines.push("");

  // Layout.
  lines.push("**Layout:**");
  for (const item of prior.layout) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // Conventions.
  lines.push("**Conventions:**");
  for (const item of prior.conventions) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // Pitfalls.
  lines.push("**Pitfalls:**");
  for (const item of prior.pitfalls) {
    lines.push(`- ${item}`);
  }

  const rendered = lines.join("\n");
  if (rendered.length <= 2000) return rendered;

  // Over the cap. Pitfalls are the first thing to go — they are the longest
  // and the least load-bearing section, and they are always rendered last, so
  // cutting at their heading keeps layout and conventions whole.
  const pitfallStart = rendered.indexOf("**Pitfalls:**");
  const withoutPitfalls =
    pitfallStart === -1 ? rendered : rendered.slice(0, pitfallStart);
  // Dropping pitfalls was enough: keep everything above them intact.
  if (withoutPitfalls.length <= 2000) return withoutPitfalls;
  // Still over: clip the tail, which eats conventions and then layout in that
  // order because they are rendered in that order. The header and the test
  // invocation sit at the head, so they always survive.
  return withoutPitfalls.slice(0, 2000);
}

// ── Accrue pitfalls ───────────────────────────────────────────────────────

/**
 * Load a prior, append lessons to pitfalls, and save.
 *
 * Returns null if the prior doesn't exist (missing file).
 *
 * Deduplicates lessons case-insensitively after whitespace collapse
 * (leading/trailing whitespace stripped, internal whitespace normalized to
 * single space). Caps pitfalls at 10, keeping the oldest entries and
 * dropping newest overflow. Increments sourceRuns by 1 and updates
 * updatedAt to the current timestamp.
 *
 * Never throws.
 */
export function accruePitfalls(
  baseDir: string,
  repo: string,
  lessons: string[],
): RepoPrior | null {
  const prior = loadPrior(baseDir, repo);
  if (prior === null) {
    return null;
  }

  // Deduplicate: keep existing pitfalls (normalized), add new unique ones.
  const existing = new Set(
    prior.pitfalls.map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()),
  );
  const newPitfalls: string[] = [...prior.pitfalls];

  for (const lesson of lessons) {
    const norm = lesson.trim().replace(/\s+/g, " ").toLowerCase();
    if (!existing.has(norm)) {
      newPitfalls.push(lesson);
      existing.add(norm);
    }
  }

  // Cap at 10, keeping oldest first (drop newest overflow).
  const capped = newPitfalls.slice(0, 10);

  const updated: RepoPrior = {
    ...prior,
    pitfalls: capped,
    sourceRuns: prior.sourceRuns + 1,
    updatedAt: new Date().toISOString(),
  };

  savePrior(baseDir, updated);
  return updated;
}

// ── Legality lint ──────────────────────────────────────────────────────────

/**
 * Lint a prior for benchmark legality.
 *
 * Returns an array of violation messages. Empty array = legal.
 *
 * Violations:
 * - Any field containing issue/PR reference patterns: "#<digits>", "issue <digits>",
 *   "fixes <digits>", GitHub issues/pull URLs.
 * - Any field containing diff content: "diff --git", lines starting with "+++"/
 *   "---", hunk markers ("@@").
 *
 * Checks all string fields and array entries.
 */
export function lintPriorLegality(prior: RepoPrior): string[] {
  const violations: string[] = [];

  // Patterns to detect.
  const issueRefPattern = /#\d+|issue\s+\d+|fixes\s+\d+/i;
  const gitHubUrlPattern = /github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/i;
  const diffHeaderPattern = /^diff\s+--git/m;
  const diffLinePattern = /^(\+\+\+|---|@@\s+-\d+,\d+\s+\+\d+,\d+)/m;

  // Collect all string fields and array entries.
  const fieldsToCheck: Array<{ name: string; value: string }> = [
    { name: "repo", value: prior.repo },
    { name: "testInvocation", value: prior.testInvocation },
    { name: "testDiscovery", value: prior.testDiscovery },
    { name: "updatedAt", value: prior.updatedAt },
    ...prior.layout.map((v, i) => ({ name: `layout[${i}]`, value: v })),
    ...prior.conventions.map((v, i) => ({
      name: `conventions[${i}]`,
      value: v,
    })),
    ...prior.pitfalls.map((v, i) => ({ name: `pitfalls[${i}]`, value: v })),
  ];

  for (const { name, value } of fieldsToCheck) {
    if (issueRefPattern.test(value)) {
      violations.push(`${name}: contains issue/PR reference`);
    }
    if (gitHubUrlPattern.test(value)) {
      violations.push(`${name}: contains GitHub issue/PR URL`);
    }
    if (diffHeaderPattern.test(value)) {
      violations.push(`${name}: contains diff header`);
    }
    if (diffLinePattern.test(value)) {
      violations.push(`${name}: contains diff content (+++/---/@@)`);
    }
  }

  return violations;
}
