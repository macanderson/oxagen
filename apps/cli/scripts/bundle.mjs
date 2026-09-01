#!/usr/bin/env node
/**
 * Build a self-contained, single-file `oxagen` CLI bundle that runs under plain
 * `node` with NO @oxagen/* workspace resolution and NO npm install step.
 *
 * Why this exists
 * ---------------
 * The published `@oxagen/cli` npm package is not standalone-installable: its
 * `dependencies` carry `workspace:*` internal packages that are unpublished,
 * and the bin shebang is `#!/usr/bin/env tsx` (needs tsx at runtime). So
 * `npm i -g @oxagen/cli` fails in a clean container.
 *
 * Container installs (bench harnesses, clean CI) use this bundle as the
 * portable artifact: one `.mjs` file + Node 22, nothing else.
 *
 * Output: apps/cli/dist-standalone/oxagen.mjs  (runnable: `node oxagen.mjs "…"`)
 */
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const entry = resolve(cliRoot, "src/index.ts");
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
        resolve(base, "index.ts"),
      ]) {
        if (existsSync(cand)) return { path: cand };
      }
      return null; // fall through to esbuild's default resolution
    });
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // A real `require`, `__filename`, and `__dirname` for bundled CJS code
  // reached under ESM: any bundled dep with a runtime (non-static) require()
  // esbuild can't hoist to a static import in ESM output, and Node-flavored
  // CJS glue that reads `__dirname`/`__filename` directly.
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
  plugins: [tsExtensionResolver],
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
