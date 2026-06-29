/**
 * Re-exports from @oxagen/code-graph — the canonical home for parser types.
 *
 * Backward-compat shim: all existing imports of "@oxagen/ingestion/parsers"
 * or relative "../parsers/types" continue to work unchanged.
 */
export type {
  SymbolKind,
  ParsedSymbol,
  ParsedLanguage,
  ParseResult,
  CallSite,
  ImportSite,
} from "@oxagen/code-graph";
