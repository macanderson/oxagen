import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectorSchemaAssets } from "./build-assets.mjs";

// Bundle the long-running Node server for the AWS instance behind
// api.oxagen.sh.
//
// `build.mjs` beside this file emits a Vercel Build Output API directory from
// `src/vercel.ts`. This emits an ordinary executable bundle from
// `src/index.ts`, which is the entrypoint that was already written for exactly
// this — "local / self-hosted: a long-running Node server". Both share the same
// Hono `app` and the same `bootstrap()`, so there is no third implementation
// and no drift between what serverless serves and what the instance serves.
//
// Why bundle at all rather than ship the source and a node_modules: the
// @oxagen/* workspace packages export raw `.ts` and are symlinked into
// node_modules, so Node cannot load them at runtime. `pnpm start` gets away
// with it by running under tsx; a production process should not be compiling
// TypeScript on every cold start, and esbuild inlines the workspace packages
// instead.

const OUT = "dist";

await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${OUT}/server.cjs`,
  bundle: true,
  platform: "node",
  // CJS, matching build.mjs: ESM output left bare builtin imports that were
  // re-resolved as npm packages, where `require()` resolves builtins natively.
  format: "cjs",
  target: "node22",

  // Identical to build.mjs's list, and identical for the same reason: these
  // are optional native bindings loaded lazily, and every one of them has a
  // pure-JS fallback or a code path that never runs here. Externalising them
  // keeps `.node` binaries esbuild cannot read out of the bundle — which
  // matters more here than on Vercel, because this artifact ships to an arm64
  // instance and a native binding built for the x86 runner would not load
  // even if esbuild could embed it.
  //
  // Nothing installs these next to the bundle, so an external that is NOT
  // optional would fail at first request rather than at build. Adding a name
  // to this list is a claim that the module is lazily required behind a
  // fallback; check that before adding one.
  external: [
    "pg-native",
    "better-sqlite3",
    "dockerode",
    "aws-sdk",
    "nock",
    "mock-aws-s3",
    "@mapbox/node-pre-gyp",
    "duckdb",
  ],
  logLevel: "info",
  // See build.mjs: createDockerSandbox uses createRequire(import.meta.url) to
  // lazily load the externalised `dockerode`, and esbuild correctly warns that
  // import.meta is empty in CJS. That path only runs under the docker sandbox
  // driver, never here.
  logOverride: { "empty-import-meta": "silent" },
});

// Built-in connector schema YAMLs are read at runtime with readFileSync, so
// esbuild cannot inline them. They are copied beside the bundle preserving the
// connectors/<id>/ layout the loader's moduleDir()-relative resolution expects.
for (const { src, dest } of connectorSchemaAssets()) {
  const destPath = `${OUT}/${dest}`;
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(src, destPath);
}

console.log(`api: bundled ${OUT}/server.cjs`);
