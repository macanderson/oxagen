/**
 * Types for the shared source code + documentation parser (@oxagen/code-graph).
 *
 * These types represent the output of parsing a file into a structured list of
 * symbols. For code (tree-sitter) those are functions, classes, methods, etc.;
 * for markdown they are heading-delimited sections. Each symbol carries enough
 * context (signature, docstring, and the raw source slice) to be embedded
 * individually for natural-language code/document search.
 *
 * Consumed by both @oxagen/ingestion (platform graph ingestion) and @oxagen/cli
 * (local code graph daemon) — the single source of truth for code structure
 * extraction across the platform.
 */

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "arrow_function"
  // Markdown heading section (one per ATX heading).
  | "heading";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** 0-indexed first row of the symbol in the source file. */
  startLine: number;
  /** 0-indexed last row of the symbol in the source file. */
  endLine: number;
  /** Leading documentation comment / JSDoc / Python or markdown section blurb. */
  docComment?: string;
  /** A single-line declaration/signature, e.g. `function foo(a: number): void`. */
  signature?: string;
  /** The full source slice for this symbol (the code itself, or the section body). */
  code?: string;
}

export type ParsedLanguage = "typescript" | "python" | "markdown" | "unknown";

export interface ParseResult {
  language: ParsedLanguage;
  symbols: ParsedSymbol[];
  /** First H1 title for markdown documents, when present. */
  title?: string;
  error?: string;
}
