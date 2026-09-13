#!/usr/bin/env node
/**
 * Compile a CommonJS bundle into a self-contained executable with Node's
 * single-executable-application (SEA) support, so a machine with no Node
 * can run it. Used for the two Oxagen desktop sidecars (`tacho`, `oxagen`)
 * and the Homebrew/scoop binaries.
 *
 *   node tools/sea/compile.mjs --entry <bundle.cjs> --name <tacho|oxagen> \
 *        --out <dir> [--triple <rust target triple>]
 *
 * Steps (docs: nodejs.org/api/single-executable-applications.html):
 *   1. write the SEA config and generate the blob with
 *      `node --experimental-sea-config`;
 *   2. copy the running `node` binary to `<out>/<name>[-<triple>][.exe]`;
 *   3. on macOS strip the Apple signature (postject cannot patch a signed
 *      Mach-O), inject the blob with postject, re-sign ad hoc; on Windows
 *      inject only (Authenticode is applied by the release workflow);
 *   4. print the path.
 *
 * `--triple` appends the Rust target triple Tauri expects on a sidecar
 * (`tacho-aarch64-apple-darwin`); Tauri strips it again inside the bundle.
 * The host Node is the runtime that ships, so run this on the target OS
 * and architecture (the release matrix does; there is no cross-compile).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const entry = args.get("--entry");
const name = args.get("--name");
const out = args.get("--out");
const triple = args.get("--triple");
if (!entry || !name || !out) {
  console.error(
    "usage: compile.mjs --entry <bundle.cjs> --name <name> --out <dir> [--triple <triple>]",
  );
  process.exit(2);
}

const require = createRequire(import.meta.url);
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const exe = `${name}${triple ? `-${triple}` : ""}${isWindows ? ".exe" : ""}`;
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });
const target = join(outDir, exe);
const work = join(outDir, `.sea-${name}`);
mkdirSync(work, { recursive: true });

function run(command, argv, opts = {}) {
  const result = spawnSync(command, argv, {
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`✖ ${command} ${argv.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// 1. blob
const blob = join(work, `${name}.blob`);
const config = join(work, "sea-config.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      main: resolve(entry),
      output: blob,
      disableExperimentalSEAWarning: true,
      // Code cache cuts cold start, which matters for the hook path.
      useCodeCache: true,
    },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", config]);

// 2. copy node
rmSync(target, { force: true });
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);

// 3. inject
if (isMac) run("codesign", ["--remove-signature", target]);
const postject = resolve(
  dirname(require.resolve("postject/package.json")),
  "dist",
  "cli.js",
);
run(process.execPath, [
  postject,
  target,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (isMac) run("codesign", ["--sign", "-", target]);

rmSync(work, { recursive: true, force: true });
const mb = (statSync(target).size / 1e6).toFixed(1);
console.log(`✔ ${name} → ${target} (${mb} MB, node ${process.version})`);
