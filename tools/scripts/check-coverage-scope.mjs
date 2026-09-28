#!/usr/bin/env node
/**
 * A package's coverage report names only that package's source.
 *
 *   node tools/scripts/check-coverage-scope.mjs apps/app
 *
 * On 2026-09-19 `@oxagen/app#test:coverage` failed its 90% floor at 76.69%
 * while all 4641 tests passed. The report counted about 80 files at 0% that
 * did not exist in `apps/app` at that commit. Their paths used
 * `[orgSlug]/[workspaceSlug]`, the retired app's route convention (#3431).
 * A report like that fails a PR for a reason that is not true, and the
 * tempting fix, lowering the threshold, would be permanent damage from a
 * transient cause.
 *
 * This reads `<pkg>/coverage/coverage-final.json` (Vitest's `json` reporter,
 * which `apps/app/vitest.config.ts` pins) and fails when the report:
 *
 *   - names a file outside `<pkg>/src`,
 *   - names a file that is not on disk, which is what the 2026-09-19 report
 *     did,
 *   - names no file at all, or is missing, so the guard cannot pass empty.
 *
 * Exit 0 when every file is in scope, 1 otherwise. It reads files only.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Vitest's `json` coverage reporter writes, relative to the package. */
export const REPORT = join("coverage", "coverage-final.json");

/**
 * The files a report names that it should not.
 *
 * @param {Record<string, unknown>} report parsed coverage-final.json
 * @param {string[]} srcRoots absolute spellings of `<pkg>/src` (as resolved
 *   and as realpath'd, since a report may use either)
 * @param {(p: string) => boolean} exists
 * @returns {{ outside: string[], missing: string[], total: number }}
 */
export function offenders(report, srcRoots, exists) {
  const outside = [];
  const missing = [];
  const files = Object.keys(report);
  for (const file of files) {
    const abs = resolve(file);
    const inside = srcRoots.some((root) => {
      const rel = relative(root, abs);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    });
    if (!inside) outside.push(file);
    else if (!exists(abs)) missing.push(file);
  }
  return { outside, missing, total: files.length };
}

/**
 * Check one package. Returns the exit code and the text to print.
 *
 * @param {string} pkgDir package directory, relative to `cwd` or absolute
 * @param {{
 *   cwd: string,
 *   read: (p: string) => string,
 *   exists: (p: string) => boolean,
 *   realpath: (p: string) => string,
 * }} io
 * @returns {{ code: 0 | 1, message: string }}
 */
export function checkPackage(pkgDir, { cwd, read, exists, realpath }) {
  const dir = resolve(cwd, pkgDir);
  const reportPath = join(dir, REPORT);
  const shown = relative(cwd, reportPath) || reportPath;
  if (!exists(reportPath)) {
    return {
      code: 1,
      message: `coverage-scope: no report at ${shown}. Run the package's coverage suite first; this guard does not pass without a report.`,
    };
  }
  let report;
  try {
    report = JSON.parse(read(reportPath));
  } catch (error) {
    return {
      code: 1,
      message: `coverage-scope: ${shown} is not valid JSON (${error.message}).`,
    };
  }
  const src = join(dir, "src");
  const roots = [src];
  if (exists(src)) {
    const real = realpath(src);
    if (real !== src) roots.push(real);
  }
  const { outside, missing, total } = offenders(report, roots, exists);
  if (total === 0) {
    return {
      code: 1,
      message: `coverage-scope: ${shown} names no files, so it measured nothing.`,
    };
  }
  if (outside.length === 0 && missing.length === 0) {
    return {
      code: 0,
      message: `coverage-scope: ${shown} names ${total} files, all under ${relative(cwd, src) || src}.`,
    };
  }
  const lines = [
    `coverage-scope: ${shown} names files that are not this package's source (#3431).`,
  ];
  if (outside.length > 0) {
    lines.push(`  ${outside.length} outside ${relative(cwd, src) || src}:`);
    for (const f of outside.slice(0, 20)) lines.push(`    ${f}`);
    if (outside.length > 20) lines.push(`    and ${outside.length - 20} more`);
  }
  if (missing.length > 0) {
    lines.push(`  ${missing.length} not on disk:`);
    for (const f of missing.slice(0, 20)) lines.push(`    ${f}`);
    if (missing.length > 20) lines.push(`    and ${missing.length - 20} more`);
  }
  lines.push(
    "The coverage figure above is not a measurement of this package. Do not lower a threshold to get past it.",
  );
  return { code: 1, message: lines.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write(
      "usage: node tools/scripts/check-coverage-scope.mjs <package-dir>...\n",
    );
    process.exit(2);
  }
  let code = 0;
  for (const dir of dirs) {
    const result = checkPackage(dir, {
      cwd: process.cwd(),
      read: (p) => readFileSync(p, "utf8"),
      exists: existsSync,
      realpath: realpathSync,
    });
    (result.code === 0 ? process.stdout : process.stderr).write(
      `${result.message}\n`,
    );
    if (result.code !== 0) code = 1;
  }
  process.exit(code);
}
