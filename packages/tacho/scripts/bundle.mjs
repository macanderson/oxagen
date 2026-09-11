#!/usr/bin/env node
/**
 * Build the three self-contained executables of @oxagen/tacho:
 *   dist-standalone/tacho.mjs       the CLI (enroll, status, unenroll, export, verify, daemon)
 *   dist-standalone/tachod.mjs      the collector daemon the user service runs
 *   dist-standalone/tacho-hook.mjs  the command hook Claude Code spawns on enforcement events
 *
 * Same pipeline as apps/cli/scripts/bundle.mjs: esbuild, ESM, node target,
 * every dependency inlined, a node shebang, executable bit set. The hook
 * binary is bundled separately and minified because its start-up time is on
 * the enforcement path (spec section 3.2).
 */
import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "dist-standalone");

const targets = [
  { name: "tacho", entry: "src/cli/main.ts", minify: false },
  { name: "tachod", entry: "src/collector/main.ts", minify: false },
  { name: "tacho-hook", entry: "src/claude-code/hook-main.ts", minify: true },
];

for (const target of targets) {
  const outfile = resolve(outDir, `${target.name}.mjs`);
  await build({
    entryPoints: [resolve(root, target.entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: target.minify,
    banner: {
      js: [
        'import { createRequire as __tacho_createRequire } from "node:module";',
        "const require = globalThis.require ?? __tacho_createRequire(import.meta.url);",
      ].join("\n"),
    },
    define: { "process.env.TACHO_BUNDLED": '"1"' },
    logLevel: "info",
    legalComments: "none",
  });
  const lines = readFileSync(outfile, "utf8").split("\n");
  while (lines.length && lines[0].startsWith("#!")) lines.shift();
  writeFileSync(outfile, ["#!/usr/bin/env node", ...lines].join("\n"));
  chmodSync(outfile, 0o755);
  console.log(`✔ ${target.name} → ${outfile}`);
}
