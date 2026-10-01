// #4664 item 2: a cached test in tools/scripts that reads a file outside the
// package must declare it as a turbo input, or live in a `*.tree.test.ts`
// file that `pnpm check:tree-guards` runs uncached. The first blocks prove the
// scan sees each way a test reads outside the package, and ignores the ways
// that read nothing. The last block runs it over every test in the package.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGE_DIR,
  TREE_TEST,
  declaredGlobs,
  describeRead,
  isDeclared,
  testFiles,
  testReads,
  undeclaredReads,
} from "./outside-reads.mjs";

const PKG = "/repo/tools/scripts";

/**
 * The reads one test makes, scanned from sources that exist only here. A key
 * that starts with `/` is a path in the fake repository, and any other key
 * is a path in the fake package.
 */
function scan(files: Record<string, string>, test = "x.test.ts") {
  const abs: Record<string, string> = {};
  for (const [key, text] of Object.entries(files)) {
    abs[key.startsWith("/") ? key : `${PKG}/${key}`] = text;
  }
  return testReads(`${PKG}/${test}`, {
    packageDir: PKG,
    repoRoot: "/repo",
    read: (file: string) => abs[file] ?? "",
    exists: (file: string) => file in abs,
  });
}

/** Each read as its path, with `/**` after a path the scan could not finish. */
function paths(files: Record<string, string>, test?: string) {
  return scan(files, test).map((r) => (r.exact ? r.path : `${r.path}/**`));
}

const HEAD = [
  'import { existsSync, readFileSync, readdirSync, spawnSync, symlinkSync } from "node:fs";',
  'import { tmpdir } from "node:os";',
  'import { dirname, join, resolve } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const ROOT = join(here, "..", "..");',
  "",
].join("\n");

describe("testReads", () => {
  it("reads a root file joined from the test's own directory", () => {
    expect(paths({ "x.test.ts": `${HEAD}readFileSync(join(ROOT, "package.json"), "utf8");` })).toEqual([
      "package.json",
    ]);
  });

  it("reads through a URL relative to the test", () => {
    const src = 'readFileSync(new URL("../../lefthook.yml", import.meta.url));';
    expect(paths({ "x.test.ts": `${HEAD}${src}` })).toEqual(["lefthook.yml"]);
  });

  it("evaluates a helper once for each call", () => {
    const src = [
      'const read = (p: string) => readFileSync(join(ROOT, p), "utf8");',
      'read("AGENTS.md");',
      'read(".github/workflows/pipeline.yml");',
    ].join("\n");
    expect(paths({ "x.test.ts": `${HEAD}${src}` })).toEqual([
      "AGENTS.md",
      ".github/workflows/pipeline.yml",
    ]);
  });

  it("evaluates a loop over a literal list once for each entry", () => {
    const src = 'for (const f of ["a.md", "b.md"]) readFileSync(join(ROOT, "docs", f));';
    expect(paths({ "x.test.ts": `${HEAD}${src}` })).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("counts the root handed to code it cannot see into as a read of the whole tree", () => {
    expect(paths({ "x.test.ts": `${HEAD}check(ROOT);` })).toEqual([""]);
    const spawn = 'spawnSync("git", ["ls-files"], { cwd: ROOT });';
    expect(paths({ "x.test.ts": `${HEAD}${spawn}` })).toEqual([""]);
    expect(describeRead(scan({ "x.test.ts": `${HEAD}check(ROOT);` })[0]!)).toBe(". (line 7)");
  });

  it("counts a path it cannot finish as a read of everything under what it knows", () => {
    const src = 'it.each(names)("%s", (n) => readFileSync(join(ROOT, "docs", n)));';
    expect(paths({ "x.test.ts": `${HEAD}${src}` })).toEqual(["docs/**"]);
  });

  it("ignores fixture strings, temp directories, and the package's own files", () => {
    const src = [
      'const target = "../.claude/skills";',
      'symlinkSync(target, join(tmpdir(), "link"));',
      'readFileSync(join(here, "fixtures", "a.json"));',
      'readFileSync(join(tmpdir(), "x"));',
      'existsSync("/repo/elsewhere");',
    ].join("\n");
    expect(paths({ "x.test.ts": `${HEAD}${src}` })).toEqual([]);
  });

  it("reads a module import that leaves the package, its own or a package module's", () => {
    const files = {
      "x.test.ts": [
        'import { run } from "./script.mjs";',
        'import "../../packages/a/src/b.js";',
        'import type { T } from "../../packages/c/src/types";',
        "run();",
      ].join("\n"),
      "script.mjs": 'import { chain } from "../../packages/tacho/src/chain";\nexport function run() { return chain; }',
      "/repo/packages/a/src/b.ts": "",
      "/repo/packages/tacho/src/chain.ts": "",
    };
    const reads = scan(files);
    expect(reads.map((r) => r.path)).toEqual(["packages/a/src/b.ts", "packages/tacho/src/chain.ts"]);
    expect(reads[1]?.via).toBe("script.mjs");
  });

  it("applies a package function's path default when the call leaves it out", () => {
    const script = [
      'import { readdirSync } from "node:fs";',
      'import { dirname, join, resolve } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");',
      "export function findGaps({ root = REPO } = {}) {",
      '  return readdirSync(join(root, "packages"));',
      "}",
      "export function brandPath(root = REPO) {",
      '  return resolve(root, "..", "brand");',
      "}",
    ].join("\n");
    const test = (call: string) => ({
      "x.test.ts": `import { brandPath, findGaps } from "./script.mjs";\n${call}`,
      "script.mjs": script,
    });
    expect(paths(test("findGaps();"))).toEqual([""]);
    expect(paths(test('findGaps({ root: "/tmp/fixture" });'))).toEqual([]);
    // A spread may carry `root`, so no default is known to apply.
    expect(paths(test("findGaps({ ...dirs, baseline: new Set() });"))).toEqual([]);
    expect(paths(test("findGaps(options);"))).toEqual([]);
    // brandPath only builds a path from its default and returns it.
    expect(paths(test("brandPath();"))).toEqual([]);
  });

  it("resolves a constant a package module exports", () => {
    const files = {
      "x.test.ts": `${HEAD}import { TEMPLATE } from "./script.mjs";\nreadFileSync(join(ROOT, TEMPLATE));`,
      "script.mjs": 'export const TEMPLATE = "infra/modules/a.tf";',
    };
    expect(paths(files)).toEqual(["infra/modules/a.tf"]);
  });

  it("reads what a package module reads when imported, and not what a direct start reads", () => {
    const files = {
      "x.test.ts": 'import "./script.mjs";',
      "script.mjs": [
        'import { readFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'import { isEntrypoint } from "./lib/is-entrypoint.mjs";',
        'const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");',
        'const DATA = readFileSync(join(REPO, "data.json"), "utf8");',
        "function main() { return readFileSync(join(REPO, \"body.json\")); }",
        'if (isEntrypoint(import.meta.url)) { readFileSync(join(REPO, "cli.json")); main(); }',
      ].join("\n"),
    };
    expect(paths(files)).toEqual(["data.json"]);
  });
});

describe("isDeclared", () => {
  const read = (path: string, exact = true) => ({ path, exact, line: 1, via: "" });

  it("covers an exact read a glob matches", () => {
    expect(isDeclared(read("package.json"), ["package.json"])).toBe(true);
    expect(isDeclared(read("apps/web/package.json"), ["apps/*/package.json"])).toBe(true);
    expect(isDeclared(read("infra/a/b.tf"), ["infra/**"])).toBe(true);
    expect(isDeclared(read("lefthook.yml"), ["package.json"])).toBe(false);
  });

  it("covers a module read with or without its extension", () => {
    expect(isDeclared(read("packages/a/src/b"), ["packages/a/src/b.ts"])).toBe(true);
    expect(isDeclared(read("packages/a/src/b.js"), ["packages/a/src/b.ts"])).toBe(true);
  });

  it("covers a directory, or a read it could not finish, only with a <dir>/** glob", () => {
    expect(isDeclared(read("docs/adr"), ["docs/adr/**"])).toBe(true);
    expect(isDeclared(read("docs/adr", false), ["docs/adr/**"])).toBe(true);
    expect(isDeclared(read("docs/adr", false), ["docs/adr/*.md"])).toBe(false);
    expect(isDeclared(read("apps", false), ["apps/*/package.json"])).toBe(false);
  });

  it("never covers the whole repository", () => {
    expect(isDeclared(read(""), ["package.json", "infra/**"])).toBe(false);
    expect(isDeclared(read("", false), ["package.json", "infra/**"])).toBe(false);
  });
});

describe("declaredGlobs", () => {
  it("returns the $TURBO_ROOT$ inputs both test tasks declare, and skips comment lines", () => {
    const text = [
      "{",
      "  // a comment turbo allows",
      '  "tasks": {',
      '    "test:unit": { "inputs": ["src/**", "$TURBO_ROOT$/a.md", "$TURBO_ROOT$/b.md"] },',
      '    "test:coverage": { "inputs": ["src/**", "$TURBO_ROOT$/a.md"] }',
      "  }",
      "}",
    ].join("\n");
    expect(declaredGlobs(text)).toEqual(["a.md"]);
  });
});

describe("every cached test in tools/scripts", () => {
  it("still sees the reads the scan was built on", () => {
    // Guards the scan against passing empty. A parser change that found no
    // read would make the check below pass for every test.
    const reads = testReads(join(PACKAGE_DIR, "check-checks-job-continues.test.ts")).map(
      (r) => r.path,
    );
    expect(reads).toEqual(
      expect.arrayContaining([".github/workflows/pipeline.yml", "package.json"]),
    );
  });

  it("finds the tree tests vitest.config.ts leaves out of turbo", () => {
    const tree = testFiles().filter((file) => TREE_TEST.test(file));
    expect(tree).toEqual(
      expect.arrayContaining([
        "audit-emit-consolidation.tree.test.ts",
        "tool-invocation-execution-identity.tree.test.ts",
        "turbo-test-inputs.tree.test.ts",
      ]),
    );
  });

  it("declares every file a cached test reads outside the package", () => {
    const report = undeclaredReads().map(
      ({ test, undeclared }) => `${test}: ${undeclared.map(describeRead).join(", ")}`,
    );
    expect(
      report,
      "Declare each file as a $TURBO_ROOT$ input of test:unit and test:coverage in " +
        "tools/scripts/turbo.json, or move the test into a *.tree.test.ts file, which " +
        "`pnpm check:tree-guards` runs uncached. `node tools/scripts/lib/outside-reads.mjs` " +
        "prints the same report.",
    ).toEqual([]);
  });
});
