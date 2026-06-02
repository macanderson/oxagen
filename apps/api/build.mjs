import { build } from "esbuild";

// Bundle the Hono app into a single self-contained Vercel function. The
// @oxagen/* workspace packages export raw .ts and are symlinked into
// node_modules, so Vercel's default function builder externalizes them and Node
// can't load .ts at runtime (ERR_MODULE_NOT_FOUND). Bundling inlines them.
//
// CJS (not ESM) output on purpose:
//  - ESM output left bare builtin imports (`import os from "os"`) that
//    @vercel/node then tried to resolve as npm packages → ERR_MODULE_NOT_FOUND.
//  - CJS uses native require(), so builtins resolve, and there's no
//    "Dynamic require of node:os is not supported" ESM pitfall.
await build({
  entryPoints: ["src/vercel.ts"],
  outfile: "api/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Optional native bindings — kept external and require()'d lazily (the DB
  // drivers catch a missing optional native module and fall back to pure JS).
  external: ["pg-native", "better-sqlite3"],
  logLevel: "info",
});
