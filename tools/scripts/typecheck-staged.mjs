#!/usr/bin/env node
// Type-check ONLY the files passed on argv (the staged TS files lefthook hands
// us), never the whole repo. Each monorepo package has its own tsconfig.json
// that extends tsconfig.base.json, so we group the changed files by their
// nearest owning tsconfig and run `tsc` once per group against a temporary
// config that extends the package config but narrows `files` to just the
// changed set, with `include` scoped to the package's ambient declaration
// files (`**/*.d.ts`). tsc then loads the staged files plus their import
// closure AND the global/ambient type files that nothing imports — chiefly
// `next-env.d.ts` (which supplies Next's `declare module "server-only"`) and
// hand-written augmentations like `apps/app/src/types/navigator-ua.d.ts`
// (`Navigator.userAgentData`). Dropping those (an empty `include`) makes
// side-effect imports and global augmentations spuriously fail (TS2882 /
// TS2551) even though the real build — which loads them via its own `include`
// — is green. `.d.ts` files are declaration-only and `skipLibCheck` is on, so
// this stays fast. Workspace packages expose `src` directly
// (main/types -> ./src/index.ts) and tsconfig.base has skipLibCheck, so no
// dependency build is required. The temp config must live inside the
// package directory so `extends: ./tsconfig.json`, `types: ["node"]`, and any
// relative compiler paths resolve exactly as they do for the real build. The
// authoritative affected-package typecheck still runs in CI
// (`turbo run typecheck --filter=...[origin/main]`).
//
// Route files. `apps/app`'s pages type their props with Next's generated
// global `PageProps<"/[org]/audit">`, declared only in the gitignored
// `.next/types/routes.d.ts`. A fresh clone or worktree has no `.next`, so every
// commit that staged a route file failed here with TS2304 while CI was green
// (#3403). The hook now does what the package's own typecheck does: when the
// owning package's `typecheck` script runs `next typegen` (today only
// `apps/app`), it runs the package's `next typegen` by its real path, as it
// runs tsc. It does so when `.next/types/routes.d.ts` is missing, and when a
// staged page, layout, or route handler declares a route that file does not
// list yet, since a new route typed `PageProps<"/new">` fails against the old
// list (#4664 item 3). Then it adds `next-env.d.ts` and
// `.next/types/routes.d.ts` to the temp config's `files` (the package's
// `exclude` hides `.next` from `include`), and no other generated file, so the
// staged program is never stricter than the package's own. It does not
// regenerate types that already list every staged route, and it generates
// nothing when no staged file belongs to such a package. Route files are then
// checked like any other staged file, so a real type error in one still fails
// the commit. The decisions live in `tools/scripts/lib/typecheck-staged-plan.mjs`.
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import {
  ROUTE_TYPES,
  generatedDeclarations,
  needsTypegen,
  stagedConfig,
  typegenCommand,
} from "./lib/typecheck-staged-plan.mjs";

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
// Root-level tooling config files (vitest.config.ts, tailwind.config.ts,
// eslint.config.mts, *.config.*) live OUTSIDE a package's compiled source root
// — package tsconfigs here use `rootDir: "src"` / `include: ["src"]`, so the
// real `tsc` build never compiles them. Forcing such a file into the temp
// config's `files` list makes tsc throw TS6059 ("not under rootDir 'src'"),
// failing the pre-commit hook on an ordinary config edit (e.g. ratcheting a
// coverage threshold). They are validated by their own tooling at runtime, so
// skip them here to mirror what the authoritative build typechecks.
const CONFIG_FILE = /(^|\/)[^/]+\.config\.(c|m)?[jt]sx?$/i;
const repoRoot = process.cwd();
// `node_modules` (and, in some worktree setups, packages beneath it) can be a
// symlink into a shared install shared across git worktrees. `pnpm`'s `.bin`
// shims `require()` their target module using a path relative to their own
// (symlink-resolved) directory; if we hand `spawnSync` the un-resolved,
// symlink-containing path, Node computes that relative `__dirname` against
// the wrong base and fails with a doubled, bogus path. Resolving to the real
// path here up front means tsc is always invoked from its true location.
const tsc = realpathSync(join(repoRoot, "node_modules", ".bin", "tsc"));

// Find the closest tsconfig.json walking up from a file toward the repo root.
function nearestTsconfig(file) {
  let dir = dirname(resolve(repoRoot, file));
  while (dir.length >= repoRoot.length) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const files = process.argv
  .slice(2)
  .filter((f) => TS_EXT.test(f) && !CONFIG_FILE.test(f));
if (files.length === 0) process.exit(0); // nothing typecheckable staged

// The file set a tsconfig compiles, after its `include`/`exclude` and any
// `extends`. A staged file the owning config excludes — apps/app's
// architecture probes under src/test/arch/probes, each written to fail a rule
// — is never compiled by the real build, so it is not compiled here either.
const compiledSets = new Map();
function compiledSet(tsconfig) {
  if (!compiledSets.has(tsconfig)) {
    const { config } = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      dirname(tsconfig),
    );
    compiledSets.set(
      tsconfig,
      new Set(parsed.fileNames.map((f) => resolve(f))),
    );
  }
  return compiledSets.get(tsconfig);
}

// Group changed files by their owning tsconfig.
const groups = new Map();
for (const file of files) {
  const tsconfig = nearestTsconfig(file);
  if (!tsconfig) continue; // no tsconfig governs this file — skip it
  const abs = resolve(repoRoot, file);
  if (!compiledSet(tsconfig).has(abs)) continue; // excluded by the owning config
  if (!groups.has(tsconfig)) groups.set(tsconfig, []);
  groups.get(tsconfig).push(abs);
}

// The package.json beside a tsconfig, or an empty object when there is none.
function packageJsonOf(pkgDir) {
  const path = join(pkgDir, "package.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

let failed = false;
for (const [tsconfig, absFiles] of groups) {
  const pkgDir = dirname(tsconfig);
  const pkgJson = packageJsonOf(pkgDir);

  const staged = absFiles.map((f) => relative(pkgDir, f));
  const hadRouteTypes = existsSync(join(pkgDir, ROUTE_TYPES));
  if (
    needsTypegen(pkgDir, pkgJson, existsSync, {
      staged,
      read: (p) => readFileSync(p, "utf8"),
    })
  ) {
    const why = hadRouteTypes
      ? "a staged route file is not in .next/types/routes.d.ts yet"
      : "missing .next/types/routes.d.ts";
    process.stdout.write(
      `typecheck-staged: generating Next route types for ${relative(repoRoot, pkgDir)} (${why})\n`,
    );
    const typegen = typegenCommand(pkgDir, repoRoot, {
      exists: existsSync,
      realpath: realpathSync,
    });
    const gen = typegen
      ? spawnSync(typegen.command, typegen.args, {
          cwd: pkgDir,
          stdio: "inherit",
        })
      : { status: null };
    if (gen.status !== 0) {
      // Say that the files were not checked, rather than let tsc report a
      // wall of TS2304 that reads like the staged change is broken.
      process.stderr.write(
        typegen
          ? `typecheck-staged: \`next typegen\` failed in ${relative(repoRoot, pkgDir)}, so its staged files were not typechecked.\n`
          : `typecheck-staged: no \`next\` binary is installed for ${relative(repoRoot, pkgDir)}, so \`next typegen\` could not run and its staged files were not typechecked. Run \`pnpm install\` at the repository root.\n`,
      );
      failed = true;
      continue;
    }
  }

  // Temp config beside the real one so extends/types/paths resolve identically.
  const tempPath = join(pkgDir, `tsconfig.staged-${process.pid}.json`);
  const declarations = generatedDeclarations(pkgDir, pkgJson, {
    exists: existsSync,
  });
  writeFileSync(tempPath, JSON.stringify(stagedConfig(staged, declarations)));
  try {
    const result = spawnSync(tsc, ["-p", tempPath], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

process.exit(failed ? 1 : 0);
