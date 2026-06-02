import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

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
  external: ["pg-native", "better-sqlite3"],
  logLevel: "info",
});

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

console.log("[build] wrote .vercel/output (Build Output API)");
