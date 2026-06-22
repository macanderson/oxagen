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
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const repoRoot = process.cwd();
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

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

const files = process.argv.slice(2).filter((f) => TS_EXT.test(f));
if (files.length === 0) process.exit(0); // nothing typecheckable staged

// Group changed files by their owning tsconfig.
const groups = new Map();
for (const file of files) {
  const tsconfig = nearestTsconfig(file);
  if (!tsconfig) continue; // no tsconfig governs this file — skip it
  if (!groups.has(tsconfig)) groups.set(tsconfig, []);
  groups.get(tsconfig).push(resolve(repoRoot, file));
}

let failed = false;
for (const [tsconfig, absFiles] of groups) {
  const pkgDir = dirname(tsconfig);
  // Temp config beside the real one so extends/types/paths resolve identically.
  const tempPath = join(pkgDir, `tsconfig.staged-${process.pid}.json`);
  writeFileSync(
    tempPath,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: true },
      files: absFiles.map((f) => relative(pkgDir, f)),
      // Load only ambient declaration files (next-env.d.ts, src/types/*.d.ts,
      // etc.) on top of `files` — NOT the whole source tree. Carries the global
      // module declarations + augmentations that side-effect imports and global
      // type extensions depend on, without re-typechecking every package file.
      include: ["**/*.d.ts"],
    }),
  );
  try {
    const result = spawnSync(tsc, ["-p", tempPath], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

process.exit(failed ? 1 : 0);
