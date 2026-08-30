#!/usr/bin/env node
/**
 * Copy non-TS runtime assets into `dist/` after `tsc`.
 *
 * `tsc` type-checks `import registryJson from "./models.json"` but does NOT emit
 * the JSON file to the output tree. The dev path (tsx) reads the source file and
 * the esbuild standalone bundle inlines it, but the plain `tsc` dist needs the
 * JSON copied next to the compiled `runtime/registry.js` so the import resolves
 * at runtime. This keeps `models.json` the single source of truth (requirement 3)
 * across every run path.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");

const assets = [["src/runtime/models.json", "dist/runtime/models.json"]];

for (const [from, to] of assets) {
  const src = resolve(cliRoot, from);
  const dst = resolve(cliRoot, to);
  if (!existsSync(src)) {
    console.error(`copy-runtime-assets: missing source ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copy-runtime-assets: ${from} -> ${to}`);
}
