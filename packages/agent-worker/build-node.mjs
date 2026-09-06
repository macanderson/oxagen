import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
// The api's asset helper, not a copy of it: both bundles externalise the same
// data files for the same loader, and its path resolution is anchored to its
// own module URL, so importing it from here resolves identically.
import { connectorSchemaAssets } from "../../apps/api/build-assets.mjs";

// Bundle the durable-run worker for the shared AWS instance — the same shape,
// for the same reasons, as apps/api/build-node.mjs: the @oxagen/* workspace
// packages export raw .ts through symlinks Node cannot load, so a production
// process gets one esbuild bundle instead of a tsx compile on every start.
//
// The externals list is the api's verbatim. Same dependency closure (this
// package reaches @oxagen/agent → handlers → everything), same rule: a name on
// this list is a claim that the module is lazily required behind a fallback.

const OUT = "dist";

await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: `${OUT}/worker.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
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
  // Left at esbuild's default (a warning) rather than silenced. `import.meta`
  // has legitimate guarded uses in this closure — connector-schema-loader.ts
  // falls back to __dirname, is-direct-run.ts tolerates undefined — so failing
  // the build on the syntax would reject correct code. What esbuild cannot see
  // is whether a use is guarded, and an *unguarded* one at module scope throws
  // at init and takes the process down before anything runs. That is what
  // src/cjs-bundle.test.ts gates, by building this bundle's dependency closure
  // and booting it in a cold Node process. Silencing was how #2567's worker
  // shipped broken: it read import.meta.url at module scope, threw
  // ERR_INVALID_ARG_TYPE on the node every time, and never completed a deploy.
});

// The handler registry the worker bootstraps reads the same connector schema
// YAMLs the api does, with the same readFileSync-relative layout.
for (const { src, dest } of connectorSchemaAssets()) {
  const destPath = `${OUT}/${dest}`;
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(src, destPath);
}

console.log(`agent-worker: bundled ${OUT}/worker.cjs`);
