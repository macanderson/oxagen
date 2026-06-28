/**
 * Source code parser — re-exports from @oxagen/code-graph.
 *
 * The canonical implementation has moved to @oxagen/code-graph; this module
 * is a backward-compat shim so all existing import paths continue to work:
 *   - import { parseSourceFile } from "@oxagen/ingestion/parsers"
 *   - import type { ParsedSymbol } from "@oxagen/ingestion/parsers"
 *   - Inngest function: ingestion.github-parse-file.ts
 */
export {
  parseSourceFile,
  getParser,
  _resetForTest,
  _injectLanguagesForTest,
  parseMarkdown,
} from "@oxagen/code-graph";

export type {
  ParseResult,
  ParsedSymbol,
  ParsedLanguage,
  SymbolKind,
  MarkdownParse,
} from "@oxagen/code-graph";
