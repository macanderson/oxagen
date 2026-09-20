#!/usr/bin/env node
/**
 * Build the three distributables from the tree on this machine and put the
 * installer where a person can double-click it:
 *
 *   1. compile `tacho` and `oxagen` into Node single-executables and stage
 *      them as the desktop app's sidecars (`apps/desktop/scripts/sidecars.mjs`);
 *   2. `tauri build` the desktop app for this OS, signed with the updater key
 *      when `~/.tauri/oxagen-desktop.key` (or TAURI_SIGNING_PRIVATE_KEY) is
 *      present, unsigned otherwise;
 *   3. copy every installer the bundler wrote for this version to `--out`
 *      (default: the Desktop) and print the sidecar versions and the digests.
 *
 *   pnpm dist:local                       # macOS: .app + .dmg → ~/Desktop
 *   pnpm dist:local --out /tmp/oxagen     # somewhere else
 *   pnpm dist:local --skip-sidecars       # reuse the staged sidecars
 *   pnpm dist:local --bundles dmg         # a subset of this OS's bundles
 *
 * Nothing here is cross-compiled: the sidecars embed the running `node`, so
 * the outputs are for the OS and architecture the script runs on. The version
 * is whatever the tree says (`apps/desktop/package.json`, kept in lockstep
 * with every other manifest by `pnpm release:*`); this script bumps nothing
 * and publishes nothing. `pnpm release:<bump>:publish` is the flow that
 * builds every platform and uploads.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const desktop = join(repo, "apps", "desktop");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const skipSidecars = argv.includes("--skip-sidecars");
const outDir = resolve(flag("--out") ?? join(homedir(), "Desktop"));

const version = JSON.parse(
  readFileSync(join(desktop, "package.json"), "utf8"),
).version;

// The bundles each OS can produce. `app` rides along on macOS because the
// updater archive (Oxagen.app.tar.gz + .sig) only exists for that target.
const DEFAULT_BUNDLES = {
  darwin: "app,dmg",
  linux: "deb,rpm,appimage",
  win32: "msi,nsis",
};
const bundles = flag("--bundles") ?? DEFAULT_BUNDLES[process.platform];
if (bundles === undefined) {
  console.error(`✖ no desktop bundle for ${process.platform}`);
  process.exit(2);
}

const INSTALLER_EXTENSIONS = [
  ".dmg",
  ".deb",
  ".rpm",
  ".AppImage",
  ".msi",
  ".exe",
];

function run(command, args, { cwd = repo, env = process.env } = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`✖ ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── preflight ────────────────────────────────────────────────────────────────

const seaCapable = capture("node", [
  "-p",
  "process.config.variables.single_executable_application",
]);
if (seaCapable !== "true") {
  console.error(
    "✖ this node cannot build single executables (Homebrew's node is built without SEA support).\n" +
      "  Put an official or nvm build first on PATH, e.g. `nvm use 24`.",
  );
  process.exit(1);
}
if (capture("rustc", ["-vV"]) === null) {
  console.error("✖ rustc is not on PATH; install Rust (stable) first");
  process.exit(1);
}

// Updater signing: the key's contents or path in TAURI_SIGNING_PRIVATE_KEY,
// with the password variable set to the empty string (an absent variable makes
// tauri prompt, which fails without a TTY). Without a key the unsigned overlay
// turns updater artifacts off so `tauri build` does not stop at "public key
// found but no private key".
const keyFile = join(homedir(), ".tauri", "oxagen-desktop.key");
const buildEnv = { ...process.env };
const tauriArgs = ["build", "--bundles", bundles];
if (!buildEnv.TAURI_SIGNING_PRIVATE_KEY && existsSync(keyFile)) {
  buildEnv.TAURI_SIGNING_PRIVATE_KEY = keyFile;
}
if (buildEnv.TAURI_SIGNING_PRIVATE_KEY) {
  buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  console.log("• updater artifacts: signed");
} else {
  tauriArgs.push("--config", "src-tauri/tauri.unsigned.conf.json");
  console.log(
    "• updater artifacts: off (no ~/.tauri/oxagen-desktop.key and no TAURI_SIGNING_PRIVATE_KEY)",
  );
}
// Without a Developer ID, sign ad hoc so the bundle carries a seal that
// `codesign --verify` accepts and Gatekeeper shows the unidentified-developer
// prompt rather than refusing the app as damaged (see desktop.yml).
if (process.platform === "darwin" && !buildEnv.APPLE_SIGNING_IDENTITY) {
  buildEnv.APPLE_SIGNING_IDENTITY = "-";
  console.log("• macOS code signing: ad hoc (no APPLE_SIGNING_IDENTITY)");
}

console.log(`\nOxagen ${version} → ${outDir} (bundles: ${bundles})`);

// ── 1. sidecars ──────────────────────────────────────────────────────────────

if (skipSidecars) {
  console.log("\n• sidecars: reusing apps/desktop/src-tauri/binaries");
} else {
  run("pnpm", ["--filter", "@oxagen/desktop", "sidecars"]);
}

const exe = process.platform === "win32" ? ".exe" : "";
const binaries = join(desktop, "src-tauri", "binaries");
const sidecars = readdirSync(binaries).filter(
  (name) => /^(tacho|oxagen)-/.test(name) && name.endsWith(exe),
);
if (sidecars.length < 2) {
  console.error(`✖ expected tacho and oxagen sidecars under ${binaries}`);
  process.exit(1);
}

// ── 2. the app ───────────────────────────────────────────────────────────────

run("pnpm", ["--filter", "@oxagen/desktop", "exec", "tauri", ...tauriArgs], {
  env: buildEnv,
});

// ── 3. collect ───────────────────────────────────────────────────────────────

const bundleDirs = walk(join(desktop, "src-tauri", "target"))
  .filter((path) => path.includes(`${join("release", "bundle")}`))
  .filter((path) => INSTALLER_EXTENSIONS.some((ext) => path.endsWith(ext)))
  .filter((path) => basename(path).includes(version));
if (bundleDirs.length === 0) {
  console.error(`✖ tauri wrote no installer for ${version}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log("\nInstallers:");
for (const path of bundleDirs) {
  const target = join(outDir, basename(path));
  copyFileSync(path, target);
  const mb = (statSync(target).size / 1e6).toFixed(1);
  console.log(`  ${target}  (${mb} MB)\n    sha256 ${sha256(target)}`);
}

console.log("\nSidecars (inside the bundle, and staged here):");
for (const name of sidecars) {
  const path = join(binaries, name);
  const reported = capture(path, ["--version"]) ?? "(no --version output)";
  console.log(`  ${path}\n    --version → ${reported}`);
}
console.log(`\n✔ Oxagen ${version} built from ${repo}`);
