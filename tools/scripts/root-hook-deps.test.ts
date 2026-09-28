/**
 * The sweep #3403 asked for, kept as a test so it holds after it lands.
 *
 * The root runs `tools/scripts/*` from git hooks, from `check:*` scripts and
 * from `pnpm gate`. Each such file resolved its imports only because a full
 * install links `@oxagen/scripts`' dependencies into `tools/scripts/node_modules`.
 * A filtered install that leaves that package out left
 * `gen-capability-schemas.ts` without `@oxagen/oxagen` and `env-check.ts`
 * without `@oxagen/config` and `kleur`, so the pre-push hook could not run.
 *
 * The rule: every package such a file imports at run time is declared in the
 * root `package.json`. This test walks the real hook and script graph and
 * fails on the first import that is not.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  entriesOf,
  expandCommand,
  installedPackageDir,
  isBuiltin,
  lefthookRuns,
  packageName,
  packagesImportedBy,
  resolveRelative,
  runtimeSpecifiers,
  simpleCommands,
  usesTsx,
} from "./lib/script-deps.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootPkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const scripts: Record<string, string> = rootPkg.scripts;
const lefthook = readFileSync(join(repoRoot, "lefthook.yml"), "utf8");

describe("reading commands", () => {
  it("splits chained commands and drops leading environment assignments", () => {
    expect(
      simpleCommands("A=1 B=2 node x.mjs && pnpm y || tsx z.ts; echo | cat"),
    ).toEqual([
      ["node", "x.mjs"],
      ["pnpm", "y"],
      ["tsx", "z.ts"],
      ["echo"],
      ["cat"],
    ]);
  });

  it("follows pnpm <script> into the root scripts, once each", () => {
    const s = {
      a: "node one.mjs && pnpm b --check",
      b: "tsx --env-file-if-exists=.env.local two.ts && pnpm run a",
    };
    expect(expandCommand("pnpm a", s)).toEqual([
      ["node", "one.mjs"],
      ["tsx", "--env-file-if-exists=.env.local", "two.ts"],
    ]);
    expect(entriesOf("pnpm a", s)).toEqual(["one.mjs", "two.ts"]);
    expect(usesTsx("pnpm a", s)).toBe(true);
    expect(usesTsx("node one.mjs", s)).toBe(false);
  });

  it("leaves commands that run inside another package to that package", () => {
    const s = { x: "node x.mjs" };
    expect(
      entriesOf(
        "pnpm --filter @oxagen/app check:messages && pnpm exec biome format . && cd packages/database && bash run.sh",
        s,
      ),
    ).toEqual([]);
  });

  it("reads npx tsx as tsx", () => {
    expect(entriesOf("npx tsx tools/scripts/seed.ts", {})).toEqual([
      "tools/scripts/seed.ts",
    ]);
  });
});

describe("reading imports", () => {
  it("keeps run-time imports and drops type-only ones", () => {
    const source = [
      'import a from "a";',
      'import type { B } from "b";',
      'import { type C } from "c";',
      'export { d } from "d";',
      'export type { E } from "e";',
      'import "f";',
      'const g = await import("g");',
      'const h = require("h");',
      "// import nope from 'comment';",
    ].join("\n");
    expect(runtimeSpecifiers(source, "x.ts", ts)).toEqual([
      "a",
      "c",
      "d",
      "f",
      "g",
      "h",
    ]);
  });

  it("names the package, not the subpath, and knows a built-in", () => {
    expect(packageName("@oxagen/config/env")).toBe("@oxagen/config");
    expect(packageName("kleur/colors")).toBe("kleur");
    expect(isBuiltin("node:fs")).toBe(true);
    expect(isBuiltin("fs/promises")).toBe(true);
    expect(isBuiltin("kleur")).toBe(false);
  });

  it("resolves an extensionless or .js relative import to its source file", () => {
    const files = new Set(["/r/lib/a.ts", "/r/lib/b.mts", "/r/lib/c/index.ts"]);
    const exists = (p: string) => files.has(p);
    expect(resolveRelative("/r/x.ts", "./lib/a", exists)).toBe("/r/lib/a.ts");
    expect(resolveRelative("/r/x.ts", "./lib/a.js", exists)).toBe(
      "/r/lib/a.ts",
    );
    expect(resolveRelative("/r/x.ts", "./lib/b.mjs", exists)).toBe(
      "/r/lib/b.mts",
    );
    expect(resolveRelative("/r/x.ts", "./lib/c", exists)).toBe(
      "/r/lib/c/index.ts",
    );
    expect(resolveRelative("/r/x.ts", "./lib/none", exists)).toBeNull();
  });

  it("looks for an installed package the way Node does, and stops at the repo root", () => {
    const files = new Set([
      "/r/tools/node_modules/k/package.json",
      "/node_modules/z/package.json",
    ]);
    const exists = (p: string) => files.has(p);
    expect(installedPackageDir("k", "/r/tools/scripts", "/r", exists)).toBe(
      "/r/tools/node_modules/k",
    );
    expect(
      installedPackageDir("z", "/r/tools/scripts", "/r", exists),
    ).toBeNull();
  });
});

describe("reading lefthook.yml", () => {
  it("returns each command's run line under its hook", () => {
    const text = [
      "pre-commit:",
      "  parallel: true",
      "  commands:",
      "    # a comment",
      "    lint:",
      '      glob: "*.ts"',
      "      run: pnpm exec eslint {staged_files}",
      "pre-push:",
      "  commands:",
      "    contracts:",
      "      run: pnpm check:contracts",
    ].join("\n");
    expect(lefthookRuns(text)).toEqual([
      {
        hook: "pre-commit",
        command: "lint",
        run: "pnpm exec eslint {staged_files}",
      },
      { hook: "pre-push", command: "contracts", run: "pnpm check:contracts" },
    ]);
  });
});

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
