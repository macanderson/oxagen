import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectorSchemaAssets } from "./build-assets.mjs";

// Bundle the long-running Node server for the AWS instance behind
// api.oxagen.sh.
//
// This emits an ordinary executable bundle from `src/index.ts`, the entrypoint
// written for exactly this — "local / self-hosted: a long-running Node server".
// It is the only build the release uses; a sibling `build.mjs` emitting a
// Vercel Build Output API directory from `src/vercel.ts` was removed with the
// rest of the Vercel deploy configuration once every app deployed to AWS.
//
// Why bundle at all rather than ship the source and a node_modules: the
// @oxagen/* workspace packages export raw `.ts` and are symlinked into
// node_modules, so Node cannot load them at runtime. `pnpm start` gets away
// with it by running under tsx; a production process should not be compiling
// TypeScript on every cold start, and esbuild inlines the workspace packages
// instead.

const OUT = "dist";

// Everything the release ships as an executable bundle.
//
// The server is the process the node runs. The CRM backfill is a one-shot
// script run as `docker exec oxagen-api node cms-crm-backfill.cjs`, inside the
// API container because that is the one place DATABASE_URL and ATTIO_API_KEY
// exist together (#3510). They share every esbuild option below — same
// platform, same target, same externals — so the entrypoint is all that varies,
// and a third artifact is a line here rather than a second call to build().
const BUNDLES = [
  { entryPoint: "src/index.ts", outfile: `${OUT}/server.cjs` },
  {
    entryPoint: "src/scripts/cms-crm-backfill.ts",
    outfile: `${OUT}/cms-crm-backfill.cjs`,
  },
];

await mkdir(OUT, { recursive: true });

for (const { entryPoint, outfile } of BUNDLES) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    // CJS: ESM output left bare builtin imports that were re-resolved as npm
    // packages, where `require()` resolves builtins natively.
    format: "cjs",
    target: "node22",

    // These are optional native bindings loaded lazily, and every one of them
    // has a pure-JS fallback or a code path that never runs here. Externalising
    // them keeps `.node` binaries esbuild cannot read out of the bundle — which
    // matters because this artifact ships to an arm64 instance and a native
    // binding built for the x86 runner would not load even if esbuild could
    // embed it.
    //
    // Nothing installs these next to the bundle, so an external that is NOT
    // optional would fail at first request rather than at build. Adding a name
    // to this list is a claim that the module is lazily required behind a
    // fallback; check that before adding one. (`dockerode` left with
    // @oxagen/sandbox in ADR-043's runtime excision.)
    external: [
      "pg-native",
      "better-sqlite3",
      "aws-sdk",
      "nock",
      "mock-aws-s3",
      "@mapbox/node-pre-gyp",
      "duckdb",
    ],
    logLevel: "info",
    // Left at esbuild's default (a warning) rather than silenced: this closure
    // has guarded uses of import.meta that are correct, and an unguarded one at
    // module scope is caught by booting the bundle. Silencing hid exactly that
    // defect in #2567.
  });
}

// Built-in connector schema YAMLs are read at runtime with readFileSync, so
// esbuild cannot inline them. They are copied beside the bundle preserving the
// connectors/<id>/ layout the loader's moduleDir()-relative resolution expects.
for (const { src, dest } of connectorSchemaAssets()) {
  const destPath = `${OUT}/${dest}`;
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(src, destPath);
}

console.log(`api: bundled ${BUNDLES.map((b) => b.outfile).join(", ")}`);
