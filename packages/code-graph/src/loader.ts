/**
 * Singleton lazy initializer for tree-sitter WASM parsers.
 *
 * tree-sitter requires async WASM initialization before any parser can be
 * created. This module initializes once and caches the Language objects
 * globally so subsequent calls are synchronous after the first await.
 *
 * WASM bundle note:
 *   The .wasm files from web-tree-sitter, tree-sitter-typescript, and
 *   tree-sitter-python are binary assets esbuild cannot inline. The CLI bundle
 *   copies them beside the executable; resolveWasm() checks there first and
 *   falls back to the monorepo node_modules walk-up for dev/vitest.
 *
 * Module: @oxagen/code-graph/loader
 * This loader is part of the checkout-local graph runtime.
 */

import Parser from "web-tree-sitter";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Resolve this module's directory LAZILY and in both module systems. This must
// never run at module scope: the CLI's CJS bundle rewrites `import.meta`, so a
// module-scope `fileURLToPath(import.meta.url)` can fail at startup.
function moduleDir(): string {
  try {
    // Real ESM (tsx dev, vitest): import.meta.url is a file:// string.
    if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // fall through to the CJS path
  }
  // esbuild CJS bundle: the Node module-wrapper __dirname global exists and
  // points at the function directory (where build.mjs copies the .wasm files).
  if (typeof __dirname === "string") return __dirname;
  return process.cwd();
}

/**
 * A `require` rooted at this module, in both module systems — used to resolve the
 * tree-sitter packages through pnpm's symlinked store (where the .wasm grammars
 * actually live, under node_modules/.pnpm). Returns null if neither
 * import.meta.url (ESM) nor __filename (CJS bundle) is available.
 */
function moduleRequire(): NodeRequire | null {
  try {
    if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
      return createRequire(import.meta.url);
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof __filename === "string") return createRequire(__filename);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Locate a tree-sitter .wasm blob. Checks, in order:
 *  1. next to this module (bundle — build.mjs copies the wasm files
 *     into the function/bundle directory),
 *  2. require.resolve of the owning package (dev / vitest — resolves through
 *     pnpm's symlinked store, the only path that works locally),
 *  3. node_modules walk-ups (package-local and monorepo-root) as a backstop.
 */
function resolveWasm(pkgRelativePath: string): string {
  const dir = moduleDir();
  const fileName = pkgRelativePath.split("/").pop() ?? pkgRelativePath;
  const pkgName = pkgRelativePath.slice(0, pkgRelativePath.indexOf("/"));

  const candidates: string[] = [
    // 1. Bundle: build.mjs copies the wasm next to this module.
    resolve(dir, fileName),
  ];

  // 2. Resolve through the package itself (handles pnpm's symlinked store).
  const req = moduleRequire();
  if (req && pkgName) {
    try {
      candidates.push(
        resolve(dirname(req.resolve(`${pkgName}/package.json`)), fileName),
      );
    } catch {
      /* package.json not resolvable from here — fall back to walk-ups */
    }
  }

  // 3. node_modules walk-ups:
  //    - packages/code-graph/node_modules (package-local)
  //    - monorepo root node_modules
  // Note: this module lives at packages/code-graph/src/, so:
  //   ../../node_modules = packages/code-graph/node_modules
  //   ../../../node_modules = monorepo root node_modules
  candidates.push(
    resolve(dir, "../../node_modules", pkgRelativePath),
    resolve(dir, "../../../node_modules", pkgRelativePath),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `tree-sitter wasm not found: ${pkgRelativePath} (looked in: ${candidates.join(", ")})`,
  );
}

let initialized = false;
let tsLanguage: Parser.Language;
let pyLanguage: Parser.Language;

/**
 * Return a configured Parser instance for the given language.
 * Initializes WASM on the first call, then returns cheaply on subsequent calls.
 */
export async function getParser(
  language: "typescript" | "python",
): Promise<Parser> {
  if (!initialized) {
    await Parser.init();

    const tsWasm = readFileSync(
      resolveWasm("tree-sitter-typescript/tree-sitter-typescript.wasm"),
    );
    const pyWasm = readFileSync(
      resolveWasm("tree-sitter-python/tree-sitter-python.wasm"),
    );

    tsLanguage = await Parser.Language.load(tsWasm);
    pyLanguage = await Parser.Language.load(pyWasm);
    initialized = true;
  }

  const parser = new Parser();
  parser.setLanguage(language === "typescript" ? tsLanguage : pyLanguage);
  return parser;
}

/**
 * Reset initialization state (test-only).
 * Allows tests to inject mock Language objects without real WASM.
 */
export function _resetForTest(): void {
  initialized = false;
}

/**
 * Inject pre-loaded Language objects (test-only).
 * Call this before getParser() in tests to avoid real WASM loading.
 */
export function _injectLanguagesForTest(
  ts: Parser.Language,
  py: Parser.Language,
): void {
  tsLanguage = ts;
  pyLanguage = py;
  initialized = true;
}
