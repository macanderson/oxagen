/**
 * Singleton lazy initializer for tree-sitter WASM parsers.
 *
 * tree-sitter requires async WASM initialization before any parser can be
 * created. This module initializes once and caches the Language objects
 * globally so subsequent calls are synchronous after the first await.
 *
 * WASM bundle note:
 *   The .wasm files from web-tree-sitter, tree-sitter-typescript, and
 *   tree-sitter-python are binary assets esbuild cannot inline. apps/api's
 *   build.mjs copies them into the Vercel function directory next to the
 *   bundle; resolveWasm() below checks there first and falls back to the
 *   monorepo node_modules walk-up for dev/vitest.
 */

import Parser from "web-tree-sitter";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Resolve this module's directory LAZILY and in both module systems. This must
// never run at module scope: esbuild's CJS bundle (apps/api → Vercel function)
// rewrites `import.meta` to an empty object, so a module-scope
// `fileURLToPath(import.meta.url)` throws ERR_INVALID_ARG_TYPE on every cold
// start and takes the whole API function down (P0 2026-06-12).
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
 * Locate a tree-sitter .wasm blob. Checks, in order:
 *  1. next to this module (Vercel bundle — build.mjs copies the wasm files
 *     into the function directory),
 *  2. the monorepo node_modules walk-up (dev / vitest, where this file lives
 *     at packages/ingestion/src/parsers/).
 */
function resolveWasm(pkgRelativePath: string): string {
  const dir = moduleDir();
  const candidates = [
    resolve(dir, pkgRelativePath.split("/").pop() ?? pkgRelativePath),
    resolve(dir, "../../../../../node_modules", pkgRelativePath),
  ];
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
