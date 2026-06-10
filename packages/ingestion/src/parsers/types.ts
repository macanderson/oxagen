/**
 * Types for the tree-sitter source code parser.
 *
 * These types represent the output of parsing a source file into a structured
 * list of top-level and nested symbols (functions, classes, methods, etc.).
 */

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "arrow_function";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  docComment?: string;
}

export interface ParseResult {
  language: "typescript" | "python" | "unknown";
  symbols: ParsedSymbol[];
  error?: string;
}
