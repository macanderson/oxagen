import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { connectorSchemaAssets } from "./build-assets.mjs";

// Emit a Vercel Build Output API directory (.vercel/output) directly, instead
// of relying on the api/ + functions convention. Why:
//  - The @oxagen/* workspace packages export raw .ts and are symlinked into
//    node_modules; Vercel's default builder externalizes them and Node can't
//    load .ts at runtime (ERR_MODULE_NOT_FOUND). esbuild inlines them.
//  - CJS (not ESM): ESM output left bare builtin imports that the platform
//    re-resolved as npm packages; CJS require() resolves builtins natively.
//  - Build Output API is served verbatim — no re-processing, no `functions`
//    glob (which can't match a build-generated file) and no framework preset
//    second-guessing the entrypoint.
//
// The whole Hono `app` is one function; config.json routes every path to it and
// Hono does the internal routing (/health, /webhooks/stripe, /api/inngest, /v1/*).

const OUT = ".vercel/output";
const FUNC = `${OUT}/functions/api.func`;

await mkdir(FUNC, { recursive: true });

await build({
  entryPoints: ["src/vercel.ts"],
  outfile: `${FUNC}/index.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Optional native bindings — required lazily; the DB drivers fall back to
  // pure JS when the native module is absent.
  //
  // `dockerode` (→ docker-modem → ssh2, which ships native .node files esbuild
  // can't load) reaches this bundle via @oxagen/sandbox, imported by the agent
  // handlers. The docker driver only runs in local dev / self-hosted, never in
  // this serverless function (SANDBOX_DRIVER=vercel|modal in prod), and
  // createDockerSandbox loads dockerode lazily — so the external require is
  // never resolved at runtime here. Externalizing it keeps the native bindings
  // out of the bundle.
  external: ["pg-native", "better-sqlite3", "dockerode"],
  logLevel: "info",
  // createDockerSandbox (packages/sandbox) uses createRequire(import.meta.url)
  // to lazily load the externalized `dockerode`. esbuild warns that import.meta
  // is empty in CJS output — true, but that code path only runs under the docker
  // sandbox driver (local dev / self-hosted), never in this serverless function,
  // so the shimmed value is never read here. Silence the false-positive.
  logOverride: { "empty-import-meta": "silent" },
});

// tree-sitter WASM blobs: packages/ingestion/src/parsers/loader.ts loads these
// lazily at runtime (repo ingestion via the bundled Inngest functions). They
// are binary assets esbuild can't inline — copy them next to the bundle, where
// loader.ts's resolveWasm() looks first (module __dirname inside the function).
// Resolve from packages/ingestion (which declares these deps); the wasm files
// are not in the packages' exports maps, so resolve each package.json and join.
const require = createRequire(
  new URL("../../packages/ingestion/package.json", import.meta.url),
);
const WASM_ASSETS = [
  ["web-tree-sitter", "tree-sitter.wasm"],
  ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  ["tree-sitter-python", "tree-sitter-python.wasm"],
];
for (const [pkg, file] of WASM_ASSETS) {
  const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  await copyFile(`${pkgDir}/${file}`, `${FUNC}/${file}`);
}

// Built-in connector schema YAMLs: packages/ingestion's loadBuiltInSchema reads
// these at runtime via readFileSync to drive connector install / "Configure"
// forms (plugin.schema.get). They are data assets esbuild can't inline — copy
// each connectors/<id>/schema.yaml next to the bundle, preserving the
// connectors/<id>/ layout so the loader's moduleDir()-relative resolution finds
// them inside the function (mirrors the .wasm copy above).
for (const { src, dest } of connectorSchemaAssets()) {
  const destPath = `${FUNC}/${dest}`;
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(src, destPath);
}

await writeFile(
  `${FUNC}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.cjs",
      launcherType: "Nodejs",
      supportsResponseStreaming: true,
      maxDuration: 60,
    },
    null,
    2,
  ),
);

await writeFile(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      // Route every request to the single Hono function (path preserved, so
      // Hono routes on the original URL).
      routes: [{ src: "/(.*)", dest: "/api" }],
    },
    null,
    2,
  ),
);

process.stdout.write("[build] wrote .vercel/output (Build Output API)\n");
