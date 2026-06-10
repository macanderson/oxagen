/**
 * Singleton lazy initializer for tree-sitter WASM parsers.
 *
 * tree-sitter requires async WASM initialization before any parser can be
 * created. This module initializes once and caches the Language objects
 * globally so subsequent calls are synchronous after the first await.
 *
 * WASM bundle note:
 *   The .wasm files from web-tree-sitter, tree-sitter-typescript, and
 *   tree-sitter-python MUST be included in the Vercel function bundle.
 *   In apps/api, add to vercel.json:
 *   {
 *     "functions": {
 *       "src/app/api/**": {
 *         "includeFiles": "node_modules/web-tree-sitter/tree-sitter.wasm,node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm,node_modules/tree-sitter-python/tree-sitter-python.wasm"
 *       }
 *     }
 *   }
 *   The Hono API uses a different bundle strategy — check apps/api/vercel.json
 *   for the correct includeFiles glob pattern for that deployment target.
 */

import Parser from "web-tree-sitter";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ESM-compatible __dirname equivalent.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    // Load WASM blobs from node_modules.
    // The resolve path walks up from packages/ingestion/src/parsers/ → monorepo root.
    const tsWasm = readFileSync(
      resolve(
        __dirname,
        "../../../../../node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
      ),
    );
    const pyWasm = readFileSync(
      resolve(
        __dirname,
        "../../../../../node_modules/tree-sitter-python/tree-sitter-python.wasm",
      ),
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
