#!/usr/bin/env node
// Every package apps/mcp externalises must be a direct dependency of apps/mcp
// (oxagen #1304).
//
// xmcp's bundler emits a bare top-level `require("duckdb")` for each name in
// `heavyPackages`, so those packages have to be on disk beside the bundle. The
// deploy tarball is built by `pnpm deploy --filter @oxagen/mcp --prod`, and pnpm
// puts a package at the top level of that tree only when apps/mcp DECLARES it.
// A package externalised but not declared resolves in dev -- the monorepo root
// happens to hold it -- and dies in production, lazily, on the first request
// that reaches it.
//
// Lazily is the whole problem. The bundle's chunk boots, /health answers, the
// deploy health check passes and rolls nothing back, and the container dies
// later with MODULE_NOT_FOUND. Nothing in the deploy pipeline can see that.
// This can, before the tarball is built.
//
// ## The five that are deliberately not declared
//
// duckdb's native loader pulls node-gyp and @mapbox/node-pre-gyp, and
// node-pre-gyp `require`s mock-aws-s3, aws-sdk and nock inside try/catch for
// features nothing here uses. They are externalised to keep the bundler from
// following those branches, not because anything resolves them at runtime --
// `require("duckdb")` succeeds in a deploy tree with none of the five present,
// which is the check that settles it.

import { readFileSync } from "node:fs";

const CONFIG = "apps/mcp/xmcp.config.ts";
const MANIFEST = "apps/mcp/package.json";

/** Externalised to silence the bundler, never resolved at runtime. */
export const NOT_RESOLVED_AT_RUNTIME = new Set([
  "node-gyp",
  "@mapbox/node-pre-gyp",
  "mock-aws-s3",
  "aws-sdk",
  "nock",
]);

/** The names in the config's `heavyPackages` array. */
export function externalisedPackages(configSource) {
  const m = /const heavyPackages[^=]*=\s*\[(.*?)\];/s.exec(configSource);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Externalised names that apps/mcp does not declare and does resolve. */
export function undeclared(packages, dependencies) {
  return packages.filter(
    (p) => !NOT_RESOLVED_AT_RUNTIME.has(p) && !(p in dependencies),
  );
}

function main() {
  const config = readFileSync(CONFIG, "utf8");
  const packages = externalisedPackages(config);
  if (packages === null) {
    // The array was renamed or restructured. Say so rather than passing: a
    // check that found nothing to read has not checked anything.
    console.error(
      `[mcp-externals-declared] could not find heavyPackages in ${CONFIG} — ` +
        "the array moved or was renamed, and this check no longer reads it.",
    );
    process.exit(1);
  }

  const deps = JSON.parse(readFileSync(MANIFEST, "utf8")).dependencies ?? {};
  const missing = undeclared(packages, deps);

  if (missing.length === 0) {
    console.log(
      `[mcp-externals-declared] all ${packages.length} externalised packages are declared or exempt`,
    );
    return;
  }

  console.error(
    "[mcp-externals-declared] externalised but not a dependency of apps/mcp:\n",
  );
  for (const p of missing) console.error(`  ${p}`);
  console.error(
    `\nAdd each to ${MANIFEST}'s dependencies. The bundle emits a bare\n` +
      "require() for it, and `pnpm deploy` puts a package at the top level of\n" +
      "the tarball only when this manifest asks for it. Undeclared, it resolves\n" +
      "in dev from the monorepo root and dies in production on the first request\n" +
      "that reaches it — after /health has already passed.",
  );
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) main();
