#!/usr/bin/env node
/**
 * prepare-standalone-publish.mjs — turn the self-contained esbuild bundle into a
 * standalone-installable npm package staged under apps/cli/dist-standalone/.
 *
 * Why this exists
 * ---------------
 * Publishing apps/cli/package.json directly is BROKEN: its `dependencies` carry
 * `@oxagen/engram`/`@oxagen/mcp-config` as `workspace:*` (unpublished internal
 * packages, and the workspace protocol leaks into the manifest), and its `bin`
 * points at dist/index.js whose shebang is `#!/usr/bin/env tsx`. So
 * `npm i -g @oxagen/cli` fails in any clean environment.
 *
 * The fix: publish ONLY the single-file bundle produced by scripts/bundle.mjs
 * (dist-standalone/oxagen.mjs — every @oxagen/* and npm dep inlined, `node`
 * shebang) plus a clean manifest with NO workspace deps. The natives left
 * external by the bundler (duckdb, blake3) go into `dependencies` — see the
 * NATIVE_DEPS block below for why they are hard, not optional.
 *
 * Run order:  scripts/bundle.mjs  →  this script  →  `npm publish dist-standalone`
 * (the release pipeline in tools/scripts/release.ts wires all three together).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "../..");
const distDir = resolve(cliRoot, "dist-standalone");
const bundle = resolve(distDir, "oxagen.mjs");

if (!existsSync(bundle)) {
  throw new Error(
    `Bundle missing at ${bundle}. Run \`pnpm --filter @oxagen/cli bundle\` first.`,
  );
}

const src = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf8"));

/**
 * Native deps left external by scripts/bundle.mjs (`external: [...]`): duckdb +
 * blake3 power the context engine (local graph replica, episodic/session+fleet
 * memory, trace store, daemon state) — which is the entire point of the CLI, so
 * they are HARD dependencies, not optional. (The benchmark path runs the raw
 * `oxagen.mjs` bundle directly without `npm install`, where they're absent and
 * the engine degrades gracefully; that path is unaffected by this manifest.)
 * Their names are the contract with scripts/bundle.mjs; versions are resolved
 * from @oxagen/engram (which owns them) so a standalone install matches the
 * monorepo runtime and never drifts.
 */
const NATIVE_DEPS = ["duckdb", "blake3"];
const engram = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/engram/package.json"), "utf8"),
);
const engramDeps = { ...engram.dependencies, ...engram.optionalDependencies };
const dependencies = {};
for (const name of NATIVE_DEPS) {
  const v = engramDeps[name];
  if (!v)
    throw new Error(
      `native dep "${name}" not found in packages/engram/package.json`,
    );
  dependencies[name] = v;
}

// Tree-sitter grammar WASM files scripts/bundle.mjs copies into dist-standalone/
// next to oxagen.mjs (see that script's WASM_ASSETS list). @oxagen/code-graph's
// resolveWasm() finds them relative to the running bundle via import.meta.url —
// but only if they're actually on disk for the installed package. Without them
// in `files`, `npm publish` silently drops the .wasm binaries and every
// `npm i -g @oxagen/cli` install gets a "tree-sitter wasm not found" code graph
// (same broken-code-graph symptom as the bundle __dirname bug, different cause).
const WASM_FILES = [
  "tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-python.wasm",
];
for (const wasmFile of WASM_FILES) {
  if (!existsSync(resolve(distDir, wasmFile))) {
    throw new Error(
      `${wasmFile} missing from ${distDir}. Run \`pnpm --filter @oxagen/cli bundle\` first.`,
    );
  }
}

const manifest = {
  name: src.name,
  version: src.version,
  description: src.description,
  type: "module",
  bin: { oxagen: "./oxagen.mjs" },
  files: ["oxagen.mjs", ...WASM_FILES, "README.md"],
  engines: { node: ">=20" },
  dependencies,
  keywords: src.keywords,
  homepage: src.homepage,
  repository: src.repository,
  publishConfig: { access: "public" },
};
if (src.license) manifest.license = src.license;

writeFileSync(
  resolve(distDir, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
copyFileSync(resolve(cliRoot, "README.md"), resolve(distDir, "README.md"));

console.log(
  `✔ standalone publish manifest written to ${resolve(distDir, "package.json")}`,
);
console.log(
  `  ${manifest.name}@${manifest.version}  (bin → ./oxagen.mjs, native deps: ${NATIVE_DEPS.join(", ")})`,
);
console.log(`  publish with:  npm publish ${distDir}`);
