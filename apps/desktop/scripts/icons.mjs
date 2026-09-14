#!/usr/bin/env node
/**
 * Generate the app icon set from the house-brand tile (the same SVG the web
 * app's favicons come from, vendored by tools/scripts/sync-brand-assets.mjs).
 * Rasterises with rsvg-convert (`brew install librsvg`) at 1024px, then lets
 * `tauri icon` emit the .icns, .ico, and PNG sizes into src-tauri/icons.
 * The generated icons are committed so a CI runner needs no librsvg.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..", "..");
const source = join(repo, "apps/app/public/brand/oxagen-icon-tile-dark.svg");
const work = join(app, "src-tauri", "icons");
mkdirSync(work, { recursive: true });
const png = join(work, "source-1024.png");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app });
  if (result.status !== 0) {
    console.error(`✖ ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

run("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, source]);
run("pnpm", ["exec", "tauri", "icon", png, "--output", work]);
console.log(`✔ icons in ${work}`);
