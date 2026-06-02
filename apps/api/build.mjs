import { build } from "esbuild";

// Bundle the Hono app into a single self-contained Vercel function. The
// @oxagen/* workspace packages export raw .ts and are symlinked into
// node_modules, so Vercel's default function builder externalizes them and Node
// can't load .ts at runtime (ERR_MODULE_NOT_FOUND). Bundling inlines them.
//
// ESM output needs a require() shim — many transitive deps are CJS and call
// require()/__dirname, which don't exist in an ESM module without this banner.
await build({
  entryPoints: ["src/vercel.ts"],
  outfile: "api/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Optional native bindings — kept external and required lazily at runtime.
  external: ["pg-native", "better-sqlite3"],
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __f } from 'url';",
      "import { dirname as __d } from 'path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __f(import.meta.url);",
      "const __dirname = __d(__filename);",
    ].join(""),
  },
  logLevel: "info",
});
