#!/usr/bin/env node
/**
 * Stage the two sidecars Tauri bundles with the app:
 *
 *   src-tauri/binaries/tacho-<triple>[.exe]
 *   src-tauri/binaries/oxagen-<triple>[.exe]
 *
 * Each is a Node single-executable built by `tools/sea/compile.mjs` from the
 * package's own `compile` script. Tauri requires the Rust target triple as a
 * suffix and strips it inside the bundle, so `runtimeCommands` in tacho sees
 * plain `tacho` next to `oxagen` at run time.
 *
 *   node scripts/sidecars.mjs [--triple <triple>] [--skip-build]
 *
 * The triple defaults to `rustc -vV`'s host. There is no cross-compile: the
 * host node is the runtime that ships, so run this on each release OS.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..", "..");
const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const tripleArg = argv.indexOf("--triple");

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host:\s*(\S+)/m.exec(result.stdout ?? "");
  if (!match) {
    console.error("cannot determine the host triple; pass --triple");
    process.exit(2);
  }
  return match[1];
}

// `--triple` with nothing after it used to name the files `tacho-undefined`,
// which Tauri then could not find.
const tripleValue = tripleArg >= 0 ? argv[tripleArg + 1] : undefined;
if (
  tripleArg >= 0 &&
  (tripleValue === undefined || tripleValue.startsWith("-"))
) {
  console.error("--triple needs a target triple, such as aarch64-apple-darwin");
  process.exit(2);
}
const triple = tripleValue ?? hostTriple();
const exe = process.platform === "win32" ? ".exe" : "";
const outDir = join(app, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const sidecars = [
  { name: "tacho", filter: "@oxagen/tacho", dir: "packages/tacho" },
  { name: "oxagen", filter: "@oxagen/cli", dir: "apps/cli" },
];

for (const { name, filter, dir } of sidecars) {
  if (!skipBuild) {
    const result = spawnSync("pnpm", ["--filter", filter, "compile"], {
      cwd: repo,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const built = join(repo, dir, "dist-bin", `${name}${exe}`);
  if (!existsSync(built)) {
    console.error(`✖ ${built} missing; run without --skip-build`);
    process.exit(1);
  }
  const staged = join(outDir, `${name}-${triple}${exe}`);
  copyFileSync(built, staged);
  console.log(`✔ ${staged}`);
}
