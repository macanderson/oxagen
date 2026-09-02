#!/usr/bin/env tsx
/**
 * check-mcp-externals.ts — every package xmcp externalises must be a declared
 * dependency of apps/mcp.
 *
 * xmcp's bundler leaves the packages in `xmcp.config.ts`'s externals list out
 * of `dist/http.js`, so they have to exist in `node_modules` beside it at
 * runtime. That tree is produced by `pnpm deploy --filter @oxagen/mcp --prod`,
 * which installs what `apps/mcp/package.json` declares — and nothing else.
 *
 * When the two disagree the build is green, the artifact ships, and the
 * service dies on its first import:
 *
 *   error: mcp did not answer on 127.0.0.1:4100/health within 60s
 *       Error: Cannot find module 'drizzle-orm/postgres-js'
 *   error: no previous release to roll back to — mcp is down
 *
 * That is #1191: 22 externals, none of them declared, discovered only when the
 * deploy pipeline reached mcp for the first time. The gap is invisible to
 * lint, typecheck and tests, because nothing in the repository imports the
 * missing package by the path the bundle will use.
 *
 * Run via `pnpm check:mcp-externals`; wired into `pnpm gate`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Packages that arrive transitively with a declared one, so requiring an
 * explicit entry for them would be noise. `duckdb` pulls its whole native
 * build toolchain, and that toolchain is what `xmcp.config.ts` externalises
 * alongside it — the comment there says as much.
 */
const TRANSITIVE_WITH_DUCKDB = new Set([
  "@mapbox/node-pre-gyp",
  "node-gyp",
  "mock-aws-s3",
  "aws-sdk",
  "nock",
  "blake3",
]);

/** Parse the externals array out of xmcp.config.ts. */
export function externalsFrom(configSource: string): string[] {
  const block = /const\s+\w+\s*(?::\s*string\[\])?\s*=\s*\[([\s\S]*?)\];/.exec(
    configSource,
  );
  if (!block) return [];
  const inner = block[1] ?? "";
  return [
    ...new Set(inner.match(/"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? []),
  ];
}

/** Externalised packages that apps/mcp does not declare. */
export function undeclared(
  externals: readonly string[],
  dependencies: Readonly<Record<string, string>>,
): string[] {
  return externals.filter(
    (name) => !TRANSITIVE_WITH_DUCKDB.has(name) && !(name in dependencies),
  );
}

function main(): void {
  const config = readFileSync(`${ROOT}/apps/mcp/xmcp.config.ts`, "utf8");
  const pkg = JSON.parse(
    readFileSync(`${ROOT}/apps/mcp/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };

  const externals = externalsFrom(config);

  // An empty result is ambiguous: either the config genuinely externalises
  // nothing, or the array moved and the parser silently missed it. Only the
  // second is possible while the config still talks about externals, and in
  // that case a clean pass here is a lie — the guard would wave through the
  // exact #1191 shape it exists to catch. Fail loudly instead.
  if (externals.length === 0 && /external/i.test(config)) {
    stdout.write(
      "check:mcp-externals — apps/mcp/xmcp.config.ts mentions externals but no " +
        "externals array could be parsed out of it. The parser looks for a " +
        'top-level `const <name> = [ "pkg", … ];`; restore that shape or update ' +
        "externalsFrom(). Refusing to report a pass it cannot actually prove.\n",
    );
    exit(1);
  }

  const missing = undeclared(externals, pkg.dependencies ?? {});

  if (missing.length > 0) {
    stdout.write(
      `check:mcp-externals — ${missing.length} package(s) are externalised from the ` +
        `mcp bundle but not declared in apps/mcp/package.json:\n` +
        missing.map((m) => `  ${m}\n`).join("") +
        `\nxmcp leaves these out of dist/http.js, and \`pnpm deploy --prod\` only ` +
        `installs what apps/mcp declares, so the service would start and fail to ` +
        `resolve one of them. Declare them, or drop them from the externals list.\n`,
    );
    exit(1);
  }

  stdout.write(
    `check:mcp-externals — ${externals.length} externals, all declared or ` +
      `transitive with duckdb.\n`,
  );
}

// pathToFileURL, not string concatenation: a repo path containing a space or a
// non-ASCII character percent-encodes in `import.meta.url` but not in argv[1],
// and the mismatch would make this guard a silent no-op that exits 0.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
