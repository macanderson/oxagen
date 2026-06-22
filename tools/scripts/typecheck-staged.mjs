#!/usr/bin/env node
// Type-check ONLY the files passed on argv (the staged TS files lefthook hands
// us), never the whole repo. Each monorepo package has its own tsconfig.json
// that extends tsconfig.base.json, so we group the changed files by their
// nearest owning tsconfig and run `tsc` once per group against a temporary
// config that extends the package config but narrows `files` to just the
// changed set (and clears `include`). tsc then loads only those files plus
// their import closure — fast, local feedback. Workspace packages expose `src`
// directly (main/types -> ./src/index.ts) and tsconfig.base has skipLibCheck,
// so no dependency build is required. The temp config must live inside the
// package directory so `extends: ./tsconfig.json`, `types: ["node"]`, and any
// relative compiler paths resolve exactly as they do for the real build. The
// authoritative affected-package typecheck still runs in CI
// (`turbo run typecheck --filter=...[origin/main]`).
import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
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

// Ambient .d.ts files that live at the package root (e.g. Next.js's
// `next-env.d.ts`) carry `/// <reference types="..." />` directives that bring
// in framework-wide ambient types — JSX, `server-only`, route types, etc.
// Without them the temp `files` config misses those references and a staged
// file that imports `server-only` (or uses JSX) gets phantom errors. Pull in
// every top-level `*.d.ts` so the resolution matches the real build.
function ambientDtsFiles(pkgDir) {
  try {
    return readdirSync(pkgDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

let failed = false;
for (const [tsconfig, absFiles] of groups) {
  const pkgDir = dirname(tsconfig);
  // Temp config beside the real one so extends/types/paths resolve identically.
  const tempPath = join(pkgDir, `tsconfig.staged-${process.pid}.json`);
  const stagedRelFiles = absFiles.map((f) => relative(pkgDir, f));
  const ambientRelFiles = ambientDtsFiles(pkgDir).filter(
    (name) => !stagedRelFiles.includes(name),
  );
  writeFileSync(
    tempPath,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: true },
      files: [...stagedRelFiles, ...ambientRelFiles],
      include: [],
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
