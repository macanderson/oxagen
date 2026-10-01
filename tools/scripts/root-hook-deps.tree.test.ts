// These tests read the root package.json and lefthook.yml, then follow the
// imports of every root check script across the repository. vitest.config.ts
// leaves *.tree.test.ts files out of turbo's cached tasks, so
// `pnpm check:tree-guards` runs them uncached in the checks job (#4664 item 2).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  entriesOf,
  lefthookRuns,
  packagesImportedBy,
} from "./lib/script-deps.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootPkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const scripts: Record<string, string> = rootPkg.scripts;
const lefthook = readFileSync(join(repoRoot, "lefthook.yml"), "utf8");

// ── The sweep, over the real tree ───────────────────────────────────────────

const declared = new Set([
  ...Object.keys(rootPkg.dependencies ?? {}),
  ...Object.keys(rootPkg.devDependencies ?? {}),
]);

const runs = lefthookRuns(lefthook);
const swept: [string, string][] = [
  ...runs.map((r): [string, string] => [
    `lefthook ${r.hook}/${r.command}`,
    r.run,
  ]),
  // Object.entries, not Object.keys: under noUncheckedIndexedAccess,
  // `scripts[name]` reads as `string | undefined` and the tuple refuses it.
  ...Object.entries(scripts)
    .filter(
      ([name]) =>
        name.startsWith("check:") || name === "gate" || name === "gate:full",
    )
    .map(([name, command]): [string, string] => [`pnpm ${name}`, command]),
];

function importsOf(command: string) {
  return packagesImportedBy(repoRoot, entriesOf(command, scripts), {
    read: (p: string) => readFileSync(p, "utf8"),
    exists: existsSync,
    ts,
    within: "tools/scripts",
  });
}

describe("root scripts declare what they import (#3403)", () => {
  it("reads the hooks it is meant to sweep", () => {
    // Guards the sweep against passing empty: a parser change that found no
    // run lines would make every assertion below vacuous.
    const names = runs.map((r) => `${r.hook}/${r.command}`);
    expect(names).toContain("pre-commit/typecheck");
    expect(names).toContain("pre-push/contracts");
    expect(names).toContain("pre-push/env-check");
  });

  it("reaches the imports that broke the filtered install", () => {
    const all = swept.flatMap(([, command]) => [...importsOf(command).keys()]);
    expect(all).toContain("@oxagen/oxagen");
    expect(all).toContain("@oxagen/config");
  });

  it.each(swept)(
    "%s imports only packages the root declares",
    (_label, command) => {
      const undeclared = [...importsOf(command)]
        .filter(([name]) => !declared.has(name))
        .map(([name, file]) => `${name} (imported by ${file})`);
      expect(undeclared).toEqual([]);
    },
  );

  it("routes every pre-push root script through the preflight", () => {
    for (const r of runs.filter((x) => x.hook === "pre-push")) {
      const script = /\bpnpm (?:run )?([\w:-]+)\s*$/.exec(r.run)?.[1];
      const command = script === undefined ? undefined : scripts[script];
      if (!script || command === undefined) continue;
      if (entriesOf(command, scripts).length === 0) continue;
      expect(r.run, `pre-push/${r.command}`).toBe(
        `node tools/scripts/hook-preflight.mjs ${script} && pnpm ${script}`,
      );
    }
  });

  it("runs the preflight before the staged typecheck", () => {
    const typecheck = runs.find(
      (r) => r.hook === "pre-commit" && r.command === "typecheck",
    );
    expect(typecheck?.run).toBe(
      "node tools/scripts/hook-preflight.mjs tools/scripts/typecheck-staged.mjs && node tools/scripts/typecheck-staged.mjs {staged_files}",
    );
  });
});
