// #4664 item 2: turbo hashes a test task over its own package. A test that
// reads a file from another package, or from the repository root, therefore
// keeps its cache key when that file changes, and main restores a pass the
// test did not earn. Each package below declares those files as inputs of its
// test tasks in its own turbo.json. This test holds that declaration.
//
// For packages/handlers and apps/web, OUTSIDE_READS lists by hand what each
// test reads. For tools/scripts, lib/outside-reads.test.ts reads each test's
// source and fails one that reads an undeclared file. This file checks the
// declarations themselves: each package config extends the root, keeps its
// inputs, and names files that exist.
//
// It reads the root turbo.json and files across the tree, so it is a tree
// test itself: `pnpm check:tree-guards` runs it uncached in the checks job.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declaredGlobs, globToRegExp } from "./lib/outside-reads.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Each package's tests, and the files outside the package each one reads, as
 * paths from the repository root.
 */
const OUTSIDE_READS: Record<string, Record<string, string[]>> = {
  "packages/handlers": {
    "src/role-check.test.ts": [
      "tools/scripts/lib/role-gate-ast.mjs",
      "tools/scripts/lib/role-gate-ast.d.mts",
    ],
    "src/mcp-studio/project.test.ts": [
      "packages/mcp-studio/fixtures/expected/tool-manifest.json",
    ],
    "src/mcp-studio/import/draft.save.test.ts": [
      "packages/mcp-studio/fixtures/servers/billing/server.toml",
    ],
  },
  "apps/web": {
    "scripts/lib/theme.test.mjs": ["packages/ui/src/styles/house-tokens.json"],
  },
};

/** The packages whose turbo.json declares outside reads. */
const PACKAGES = [...Object.keys(OUTSIDE_READS), "tools/scripts"];

/** A turbo.json, with its full-line `//` comments removed. */
function readTurbo(path: string) {
  const text = readFileSync(join(REPO_ROOT, path), "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return JSON.parse(text) as {
    extends?: string[];
    tasks: Record<string, { inputs?: string[] }>;
  };
}

/**
 * Whether a declared glob names at least one file in the tree. A glob with
 * no wildcard must name a file that exists. A wildcard glob must match a file
 * under the directory its fixed part names.
 */
function matchesAFile(glob: string): boolean {
  if (!glob.includes("*")) return existsSync(join(REPO_ROOT, glob));
  const fixed = glob.slice(0, glob.indexOf("*"));
  const dir = fixed.slice(0, fixed.lastIndexOf("/"));
  if (!existsSync(join(REPO_ROOT, dir))) return false;
  const pattern = globToRegExp(glob);
  const walk = (rel: string): boolean => {
    for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory() ? walk(path) : pattern.test(path)) return true;
    }
    return false;
  };
  return walk(dir);
}

/**
 * Inputs declared for a file that must not exist. mcp-single-instance.test.ts
 * asserts apps/mcp/vercel.json is absent, so the input re-runs that test if
 * someone adds the file.
 */
const ABSENT_BY_DESIGN = new Set(["apps/mcp/vercel.json"]);

const root = readTurbo("turbo.json");
const TASKS = ["test:unit", "test:coverage"] as const;

describe.each(PACKAGES)("%s", (pkg) => {
  const config = readTurbo(`${pkg}/turbo.json`);

  it("extends the root config", () => {
    expect(config.extends).toEqual(["//"]);
  });

  it.each(TASKS)("keeps every root input of %s", (task) => {
    expect(config.tasks[task]?.inputs).toEqual(
      expect.arrayContaining(root.tasks[task]?.inputs ?? []),
    );
  });

  it("declares the same outside inputs for both test tasks", () => {
    const rooted = (task: (typeof TASKS)[number]) =>
      (config.tasks[task]?.inputs ?? []).filter((input) =>
        input.startsWith("$TURBO_ROOT$/"),
      );
    expect(rooted("test:coverage")).toEqual(rooted("test:unit"));
  });

  it("declares no outside input that names nothing in the tree", () => {
    // A renamed or deleted file leaves an input that re-runs nothing. The
    // test that read it moved on, and the declaration is a stale record.
    const text = readFileSync(join(REPO_ROOT, pkg, "turbo.json"), "utf8");
    const missing = declaredGlobs(text).filter(
      (glob) => !ABSENT_BY_DESIGN.has(glob) && !matchesAFile(glob),
    );
    expect(missing).toEqual([]);
  });

  const reads: Record<string, string[]> = OUTSIDE_READS[pkg] ?? {};
  describe.each(Object.entries(reads))("%s", (testFile, files) => {
    it("exists, and so does each file it reads", () => {
      expect(existsSync(join(REPO_ROOT, pkg, testFile))).toBe(true);
      for (const file of files) expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    });

    it.each(TASKS)("declares each file as an input of %s", (task) => {
      const globs = (config.tasks[task]?.inputs ?? [])
        .filter((input) => input.startsWith("$TURBO_ROOT$/"))
        .map((input) => globToRegExp(input.slice("$TURBO_ROOT$/".length)));
      for (const file of files) {
        expect(
          globs.some((glob) => glob.test(file)),
          `${file} is not an input of ${pkg}'s ${task}`,
        ).toBe(true);
      }
    });
  });
});
