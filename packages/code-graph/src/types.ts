/**
 * Types for the local source code + documentation parser (@oxagen/code-graph).
 *
 * These types represent the output of parsing a file into a structured list of
 * symbols. For code (tree-sitter) those are functions, classes, methods, etc.;
 * for markdown they are heading-delimited sections. Each symbol carries enough
 * context (signature, docstring, and the raw source slice) to be embedded
 * individually for natural-language code/document search.
 *
 * Consumed by the local CLI/engine graph. Parsed source, snippets, and detailed
 * symbols do not flow into the Oxagen workspace graph.
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

/**
 * A call site extracted from the source file.
 *
 * The `enclosingSymbol` is the name of the function/method/arrow_function whose
 * line range contains the call expression, or null for module-level calls.  The
 * caller name is used for same-file CALLS edge resolution; cross-file
 * resolution is not implemented yet.
 */
export interface CallSite {
  /** The function or method name being called (identifier or member property). */
  callee: string;
  /** 0-indexed line of the call_expression node. */
  line: number;
  /** Name of the enclosing symbol, or null if the call is at module scope. */
  enclosingSymbol: string | null;
}

/**
 * An import specifier extracted from an import or re-export statement.
 *
 * Consumers use this to build IMPORTS edges.  Both relative ('./utils') and
 * bare specifiers ('@oxagen/ai', 'react') are surfaced so consumers can decide
 * which to resolve.
 */
export interface ImportSite {
  /** The raw import specifier, e.g. "@oxagen/ai", "./utils", "react". */
  specifier: string;
  /** 0-indexed line of the import_statement or export_statement node. */
  line: number;
}

export interface ParseResult {
  language: ParsedLanguage;
  symbols: ParsedSymbol[];
  /** First H1 title for markdown documents, when present. */
  title?: string;
  error?: string;
  /**
   * Call sites extracted from the source (TypeScript/JavaScript and Python).
   * Omitted (undefined) for Markdown and unknown files.
   */
  calls?: CallSite[];
  /**
   * Import specifiers extracted from the source (TypeScript/JavaScript and
   * Python). Includes both relative and bare specifiers; callers resolve them.
   * Omitted (undefined) for Markdown and unknown files.
   */
  imports?: ImportSite[];
}
