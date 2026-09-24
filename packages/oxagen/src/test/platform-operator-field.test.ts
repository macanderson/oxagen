/**
 * INV-31, second mechanism: the platform-operator binding has exactly one
 * producer and one consumer outside this package.
 *
 * The kernel check (kernel.test.ts) refuses a `platformOnly` capability without
 * a minted binding and refuses any value the registry does not hold. That
 * stops a forgery. It does not stop a surface from legitimately minting one and
 * handing a customer's request platform-operator authority — the mistake that
 * would make `set_org_billing_terms` reachable from the internet with no
 * forgery at all.
 *
 * So this walks the source tree and asserts where the two names may appear.
 * `*.test.ts` files are excluded: the builder tests in apps/api and apps/mcp,
 * and this file, spell `platformOperator` in order to assert its absence.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: packages/oxagen/src/test/<this file> → four levels up. */
const REPO_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** The names this test governs. */
const GOVERNED = ["platformOperator", "createPlatformOperatorContext"] as const;

/**
 * The only file outside packages/oxagen allowed to name either: the operator
 * script that mints a binding and invokes `set_org_billing_terms` with it.
 */
const ALLOWED = new Set([
  "tools/scripts/billing-terms.ts",
  "tools/scripts/run-outcomes-access.ts",
  // The shared invoke path of the enterprise-invoicing operator scripts
  // (pnpm billing:contract-terms, pnpm billing:prepaid-invoice, ADR-165).
  // The scripts themselves name neither identifier; they call through it.
  "tools/scripts/lib/platform-operator-run.ts",
]);

/** The package that owns the binding; everything under it is exempt. */
const OWNING_PACKAGE = "packages/oxagen";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".git",
]);

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(full, out);
      continue;
    }
    // A test may spell the name to assert its absence, which is what the three
    // builder tests and this file do.
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** Every apps/<app>/src and packages/<pkg>/src directory that exists. */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(REPO_ROOT, group);
    let members: string[];
    try {
      members = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const member of members) {
      if (SKIP_DIRS.has(member)) continue;
      const src = join(groupDir, member, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // A workspace member with no src/ (apps/web is hand-authored HTML).
      }
    }
  }
  return roots;
}

/** Repo-relative, forward-slashed, so an assertion message names a real path. */
function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

function filesNaming(name: string, files: string[]): string[] {
  return files
    .filter((file) => readFileSync(file, "utf8").includes(name))
    .map(repoPath)
    .sort();
}

describe("INV-31 — the platform-operator binding has one producer and one consumer", () => {
  const roots = sourceRoots();
  const appFiles = walk(join(REPO_ROOT, "tools", "scripts"), []).concat(
    ...roots.map((root) => walk(root, [])),
  );

  it("walks a tree that actually contains this package and the operator script", () => {
    const paths = appFiles.map(repoPath);
    expect(paths).toContain("packages/oxagen/src/platform-operator.ts");
    expect(paths).toContain("tools/scripts/billing-terms.ts");
    expect(paths.length).toBeGreaterThan(100);
  });

  it.each(GOVERNED)(
    "`%s` appears outside packages/oxagen only in the operator script",
    (name) => {
      const outside = filesNaming(name, appFiles).filter(
        (path) => !path.startsWith(`${OWNING_PACKAGE}/`),
      );
      expect(outside.every((path) => ALLOWED.has(path))).toBe(true);
      expect(outside).toEqual([...ALLOWED].sort());
    },
  );

  it("finds both names in the operator script, so the walk proves something", () => {
    // Without this the two assertions above would also pass on a tree where
    // nothing names the binding at all.
    const script = readFileSync(
      join(REPO_ROOT, "tools/scripts/billing-terms.ts"),
      "utf8",
    );
    for (const name of GOVERNED) expect(script).toContain(name);
  });
});
