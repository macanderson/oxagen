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
 * Output: apps/cli/dist-standalone/oxagen.mjs  (runnable: `node oxagen.mjs "…"`)
 */
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // Native, optional deps of the context engine (@oxagen/engram). They are loaded
  // lazily and the CLI degrades gracefully when absent (see src/agent/memory.ts and
  // the createRequire shim at the top of src/index.tsx), so a benchmark container
  // without them still runs the full agent loop — it just skips persistent memory.
  // Native, optional deps reached lazily via require() — safe to leave external
  // (they are NOT eagerly imported, and the CLI degrades gracefully when absent).
  external: ["duckdb", "blake3"],
  // A real `require` for any externalized CJS native (e.g. duckdb) reached via
  // require()/createRequire under ESM. The node shebang is fixed up post-build.
  banner: {
    js: [
      'import { createRequire as __ox_createRequire } from "node:module";',
      "const require = globalThis.require ?? __ox_createRequire(import.meta.url);",
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

console.log(`\n✔ oxagen standalone bundle written to ${outfile}`);
console.log("  Run it with:  node " + outfile + " --version");
