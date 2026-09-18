#!/usr/bin/env node
/**
 * Stub the two things `tauri-build` needs on disk before the Rust crate will
 * compile: the `externalBin` sidecars for this host's target triple, and a
 * `frontendDist`. `cargo test` and `cargo clippy` never run either, so an
 * empty script and a one-line page are enough, and a real build's files are
 * left alone when they are already there. Both paths are gitignored.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const triple = /^host: (.+)$/m.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)?.[1];
if (triple === undefined) {
  console.error("rig-stubs: `rustc -vV` did not name a host triple");
  process.exit(1);
}
const ext = triple.includes("windows") ? ".exe" : "";
const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
for (const name of ["tacho", "oxagen"]) {
  const file = join(binaries, `${name}-${triple}${ext}`);
  if (existsSync(file)) continue;
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  console.log(`rig-stubs: wrote ${file}`);
}
const page = join(root, "dist", "index.html");
if (!existsSync(page)) {
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, "<!doctype html><title>stub</title>\n");
  console.log(`rig-stubs: wrote ${page}`);
}
