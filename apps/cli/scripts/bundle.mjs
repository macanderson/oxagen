#!/usr/bin/env node
/**
 * Build a self-contained, single-file `oxagen` CLI bundle that runs under plain
 * `node` with NO @oxagen/* workspace resolution and NO npm install step.
 *
 * Why this exists
 * ---------------
 * The published `@oxagen/cli` npm package is not standalone-installable: its
 * `dependencies` still carry `@oxagen/engram: workspace:*` (the workspace
 * protocol leaked into the publish) and those internal packages are unpublished,
 * and the bin shebang is `#!/usr/bin/env tsx` (needs tsx at runtime). So
 * `npm i -g @oxagen/cli` fails in a clean container.
 *
 * Benchmark harnesses (Harbor / Terminal-Bench) drop the agent into an ephemeral
 * task container that has neither the monorepo nor a working npm publish. This
 * bundle is the portable artifact we upload into that container: one `.mjs` file
 * + Node 22, nothing else.
 *
 * WASM grammars:
 * The CLI now uses @oxagen/code-graph (tree-sitter) for code-graph construction.
 * tree-sitter WASM files are binary assets esbuild cannot inline; they are copied
 * next to the bundle so the loader's resolveWasm() finds them via import.meta.url
 * (ESM bundle: import.meta.url is the bundle's own URL, so moduleDir() = the
 * dist-standalone/ directory where the wasm files live).
 *
 * Output: apps/cli/dist-standalone/oxagen.mjs  (runnable: `node oxagen.mjs "…"`)
 */
import { build } from "esbuild";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const entry = resolve(cliRoot, "src/index.tsx");
const outfile = resolve(cliRoot, "dist-standalone/oxagen.mjs");

/**
 * The CLI (and the @oxagen/* source packages it pulls in) import sibling modules
 * with explicit `.js` specifiers that actually resolve to `.ts`/`.tsx` on disk —
 * the Turbopack/tsx convention. esbuild does not remap `.js` -> `.ts`, so do it
 * here for every relative specifier.
 */
const tsExtensionResolver = {
  name: "ts-js-extension-resolver",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (!args.path.startsWith(".")) return null; // packages resolve normally
      const base = resolve(args.resolveDir, args.path.slice(0, -3));
      for (const cand of [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.mjs`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
      ]) {
        if (existsSync(cand)) return { path: cand };
      }
      return null; // fall through to esbuild's default resolution
    });
  },
};

/**
 * Neutralize dev-only modules that are *statically* imported (so externalizing
 * them would make Node eagerly resolve a missing package and crash at startup),
 * but are never exercised by the headless agent. ink statically imports
 * `react-devtools-core` for its dev-tools bridge; stub it to a no-op.
 */
const STUBBED = /^react-devtools-core$/;
const stubDevOnlyModules = {
  name: "stub-dev-only-modules",
  setup(b) {
    b.onResolve({ filter: STUBBED }, (args) => ({
      path: args.path,
      namespace: "ox-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "ox-stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Native deps of the context engine (@oxagen/engram). esbuild cannot inline a
  // .node addon, and they are reached lazily via require() (see src/agent/memory.ts
  // and the createRequire shim at the top of src/index.tsx) rather than eagerly
  // imported — so leaving them external is safe: a benchmark container without them
  // still runs the full agent loop, it just skips persistent memory. A real
  // `npm i -g` install DOES get them; scripts/prepare-standalone-publish.mjs puts
  // this same list into the published manifest's `dependencies`.
  external: ["duckdb", "blake3"],
  // A real `require`, `__filename`, and `__dirname` for bundled CJS code reached
  // under ESM. Two distinct needs:
  //  - `require`: externalized natives (e.g. duckdb) reached via require()/
  //    createRequire, plus any bundled dep with a runtime (non-static) require()
  //    esbuild can't hoist to a static import in ESM output.
  //  - `__filename`/`__dirname`: web-tree-sitter's tree-sitter.js is Emscripten-
  //    generated UMD glue with a Node-environment branch
  //    (`ENVIRONMENT_IS_NODE`) that reads `__dirname` directly (to locate its own
  //    tree-sitter.wasm runtime blob next to itself) — undeclared in real ESM,
  //    so without this shim Parser.init() throws "__dirname is not defined" on
  //    every call, and since the failure happens before loader.ts's `initialized`
  //    flag is set, EVERY parseSourceFile() call re-throws it — the whole code
  //    graph silently comes back empty (P0 2026-07-02: 2,644/2,644 files failed
  //    on a Django repo smoke run). loader.ts's own moduleDir()/resolveWasm()
  //    already prefer import.meta.url and are unaffected — this shim is for the
  //    bundled *dependency* code, not our own.
  // The node shebang is fixed up post-build.
  banner: {
    js: [
      'import { createRequire as __ox_createRequire } from "node:module";',
      'import { fileURLToPath as __ox_fileURLToPath } from "node:url";',
      'import { dirname as __ox_dirname } from "node:path";',
      "const require = globalThis.require ?? __ox_createRequire(import.meta.url);",
      "const __filename = __ox_fileURLToPath(import.meta.url);",
      "const __dirname = __ox_dirname(__filename);",
    ].join("\n"),
  },
  plugins: [stubDevOnlyModules, tsExtensionResolver],
  loader: { ".node": "copy" },
  logLevel: "info",
  metafile: false,
  legalComments: "none",
});

// esbuild preserves the entry file's `#!/usr/bin/env tsx` shebang. Replace any
// leading shebang line(s) with a single Node one so the bundle runs under plain
// `node` (and is directly executable), then mark it executable.
const lines = readFileSync(outfile, "utf8").split("\n");
while (lines.length && lines[0].startsWith("#!")) lines.shift();
writeFileSync(outfile, ["#!/usr/bin/env node", ...lines].join("\n"));
chmodSync(outfile, 0o755);

// Copy tree-sitter WASM grammars next to the bundle.
// @oxagen/code-graph/src/loader.ts's resolveWasm() checks moduleDir() first
// (which is the bundle's directory in ESM bundles — import.meta.url points at
// the oxagen.mjs file, so dirname(fileURLToPath(import.meta.url)) = dist-standalone/).
// Resolve from @oxagen/code-graph since it owns the tree-sitter deps.
const outDir = dirname(outfile);
mkdirSync(outDir, { recursive: true });
const codeGraphRequire = createRequire(
  new URL("../../../packages/code-graph/package.json", import.meta.url),
);
const WASM_ASSETS = [
  ["web-tree-sitter", "tree-sitter.wasm"],
  ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  ["tree-sitter-python", "tree-sitter-python.wasm"],
];
for (const [pkg, file] of WASM_ASSETS) {
  const pkgDir = dirname(codeGraphRequire.resolve(`${pkg}/package.json`));
  const src = resolve(pkgDir, file);
  const dest = resolve(outDir, file);
  copyFileSync(src, dest);
  console.log(`  copied ${file} → dist-standalone/`);
}

console.log(`\n✔ oxagen standalone bundle written to ${outfile}`);
console.log("  Run it with:  node " + outfile + " --version");
