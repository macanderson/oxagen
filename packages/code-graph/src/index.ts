/**
 * @oxagen/code-graph — unified tree-sitter source code parser.
 *
 * THE single source of code-graph construction for the Oxagen platform:
 *   - packages/ingestion: platform workspace graph (SourceFile / SourceSymbol nodes)
 *   - apps/cli: local code-graph daemon (CodeNode persistence in DuckDB)
 *
 * The TypeScript grammar handles JS/JSX as well as TS/TSX, so JS files are
 * parsed fully without a separate grammar.
 *
 * Language coverage: TypeScript / JavaScript / JSX / TSX, Python, Markdown/MDX.
 * Go / Rust / Java are a documented follow-up (separate grammar packages).
 */

import { extname } from "path";
import { getParser } from "./loader";
import { parseMarkdown } from "./markdown";
import type { ParseResult, ParsedSymbol, ParsedLanguage, SymbolKind, CallSite, ImportSite } from "./types";

export type { ParseResult, ParsedSymbol, ParsedLanguage, SymbolKind, CallSite, ImportSite };
export { getParser, _resetForTest, _injectLanguagesForTest } from "./loader";
export { parseMarkdown } from "./markdown";
export type { MarkdownParse } from "./markdown";
export { inferDomains } from "./domains";
export type { DomainAI, DomainInferInput, DomainMap } from "./domains";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(filePath: string): ParsedLanguage {
  const ext = extname(filePath).toLowerCase();
  // The TypeScript grammar handles JS/JSX/MJS/CJS as well as TS/TSX.
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return "markdown";
  return "unknown";
}

// ---------------------------------------------------------------------------
// TypeScript query patterns
// ---------------------------------------------------------------------------

const TS_QUERIES = [
  {
    query: "(function_declaration name: (identifier) @name) @node",
    kind: "function" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
  {
    query: "(class_declaration name: (type_identifier) @name) @node",
    kind: "class" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
  {
    query: "(method_definition name: (property_identifier) @name) @node",
    kind: "method" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
  {
    query: "(interface_declaration name: (type_identifier) @name) @node",
    kind: "interface" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
  {
    query: "(type_alias_declaration name: (type_identifier) @name) @node",
    kind: "type" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
];

// Arrow functions assigned to a const/let/var at the top level or inside a
// class body.  We capture the variable name from the parent lexical_declaration
// or public_field_definition, not from the arrow function node itself.
const TS_ARROW_QUERY =
  "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node";

/**
 * Call-site query: matches every call_expression and captures the callee
 * identifier (or the final method property for member calls).
 *
 * Examples matched:
 *   foo()              → callee "foo"
 *   obj.bar()          → callee "bar"
 *   this.doWork()      → callee "doWork"
 *   a.b.transform()    → callee "transform"
 *
 * Note: decorator calls and type-assertion-only expressions are not matched
 * by this pattern, which is intentional (we want runtime call edges only).
 */
const TS_CALL_QUERY =
  "(call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node";

/**
 * Import-statement query: captures the specifier string of every static
 * `import … from "…"` declaration (TypeScript/JavaScript).
 */
const TS_IMPORT_QUERY =
  "(import_statement source: (string (string_fragment) @specifier)) @node";

/**
 * Re-export query: captures the specifier of `export { … } from "…"` and
 * `export * from "…"` — both are import-like declarations that create edges.
 */
const TS_REEXPORT_QUERY =
  "(export_statement source: (string (string_fragment) @specifier)) @node";

// ---------------------------------------------------------------------------
// Python query patterns
// ---------------------------------------------------------------------------

const PY_QUERIES = [
  {
    query: "(function_definition name: (identifier) @name) @node",
    kind: "function" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
  {
    query: "(class_definition name: (identifier) @name) @node",
    kind: "class" as SymbolKind,
    nameCapture: "name",
    nodeCapture: "node",
  },
];

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

import type Parser from "web-tree-sitter";

function runQueries(
  tree: Parser.Tree,
  language: Parser.Language,
  queryDefs: Array<{
    query: string;
    kind: SymbolKind;
    nameCapture: string;
    nodeCapture: string;
  }>,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const def of queryDefs) {
    let q: Parser.Query;
    try {
      q = language.query(def.query);
    } catch {
      // Silently skip unsupported query patterns for a given grammar version.
      continue;
    }

    const matches = q.matches(tree.rootNode);
    for (const match of matches) {
      const nameNode = match.captures.find(
        (c) => c.name === def.nameCapture,
      )?.node;
      const outerNode = match.captures.find(
        (c) => c.name === def.nodeCapture,
      )?.node;

      if (!nameNode || !outerNode) continue;

      const name = nameNode.text;
      if (!name) continue;

      symbols.push({
        name,
        kind: def.kind,
        startLine: outerNode.startPosition.row,
        endLine: outerNode.endPosition.row,
      });
    }
  }

  return symbols;
}

function runArrowQuery(
  tree: Parser.Tree,
  language: Parser.Language,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let q: Parser.Query;
  try {
    q = language.query(TS_ARROW_QUERY);
  } catch {
    return symbols;
  }

  const matches = q.matches(tree.rootNode);
  for (const match of matches) {
    const nameNode = match.captures.find((c) => c.name === "name")?.node;
    const outerNode = match.captures.find((c) => c.name === "node")?.node;
    if (!nameNode || !outerNode) continue;
    const name = nameNode.text;
    if (!name) continue;
    symbols.push({
      name,
      kind: "arrow_function",
      startLine: outerNode.startPosition.row,
      endLine: outerNode.endPosition.row,
    });
  }

  return symbols;
}

/**
 * Extract call sites from a TypeScript/JavaScript parse tree.
 *
 * For each call_expression the query matches, we resolve the `enclosingSymbol`
 * by finding the narrowest already-extracted symbol whose [startLine, endLine]
 * range contains the call's line.  Module-level calls (not inside any symbol)
 * have enclosingSymbol = null.
 */
function runCallQuery(
  tree: Parser.Tree,
  language: Parser.Language,
  symbols: ParsedSymbol[],
): CallSite[] {
  const calls: CallSite[] = [];
  let q: Parser.Query;
  try {
    q = language.query(TS_CALL_QUERY);
  } catch {
    return calls;
  }

  const matches = q.matches(tree.rootNode);
  const seen = new Set<string>(); // deduplicate callee:line pairs
  for (const match of matches) {
    const calleeCapture = match.captures.find((c) => c.name === "callee");
    const nodeCapture = match.captures.find((c) => c.name === "node");
    if (!calleeCapture || !nodeCapture) continue;

    const callee = calleeCapture.node.text;
    if (!callee) continue;
    const line = nodeCapture.node.startPosition.row;

    // Deduplicate same callee on same line (e.g. nested capture patterns).
    const dedupeKey = `${callee}:${line}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Find the narrowest enclosing symbol by line range.
    let enclosingSymbol: string | null = null;
    let bestSize = Infinity;
    for (const sym of symbols) {
      if (sym.startLine <= line && sym.endLine >= line) {
        const size = sym.endLine - sym.startLine;
        if (size < bestSize) {
          bestSize = size;
          enclosingSymbol = sym.name;
        }
      }
    }

    calls.push({ callee, line, enclosingSymbol });
  }

  return calls;
}

/**
 * Extract import specifiers from a TypeScript/JavaScript parse tree.
 *
 * Returns both import_statement and export_statement sources (re-exports) so
 * all inbound/outbound module dependencies are captured.  Both relative
 * ('./utils') and bare ('@oxagen/ai', 'react') specifiers are returned —
 * callers decide which to resolve.
 */
function runImportQuery(
  tree: Parser.Tree,
  language: Parser.Language,
): ImportSite[] {
  const imports: ImportSite[] = [];
  const seen = new Set<string>(); // deduplicate specifier:line pairs

  for (const queryStr of [TS_IMPORT_QUERY, TS_REEXPORT_QUERY]) {
    let q: Parser.Query;
    try {
      q = language.query(queryStr);
    } catch {
      continue;
    }

    const matches = q.matches(tree.rootNode);
    for (const match of matches) {
      const specCapture = match.captures.find((c) => c.name === "specifier");
      const nodeCapture = match.captures.find((c) => c.name === "node");
      if (!specCapture || !nodeCapture) continue;

      const specifier = specCapture.node.text;
      if (!specifier) continue;
      const line = nodeCapture.node.startPosition.row;

      const dedupeKey = `${specifier}:${line}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      imports.push({ specifier, line });
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Symbol enrichment — code slice, signature, leading doc comment
// ---------------------------------------------------------------------------

// Cap the stored source slice per symbol so a giant class/function doesn't bloat
// the node or the embedding input. Most symbols are far smaller; oversized ones
// are truncated (the chunk index still covers the full file body).
const MAX_SYMBOL_CODE_CHARS = 4000;

/** The raw source for a symbol, from its 0-indexed line range (inclusive). */
function sliceCode(lines: string[], startLine: number, endLine: number): string {
  const slice = lines.slice(startLine, endLine + 1).join("\n");
  return slice.length > MAX_SYMBOL_CODE_CHARS
    ? `${slice.slice(0, MAX_SYMBOL_CODE_CHARS)}\n… (truncated)`
    : slice;
}

/** A one-line signature: the symbol's declaration line, trimmed and capped. */
function firstSignificantLine(lines: string[], startLine: number, endLine: number): string {
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length > 0) return t.slice(0, 300);
  }
  return "";
}

/**
 * Leading documentation immediately above a symbol: a contiguous block of `//`,
 * `/* … *​/`, `*`, or `#` comment lines directly preceding the declaration. For
 * Python def/class, also captures a triple-quoted docstring on the first body line.
 */
function extractDocComment(lines: string[], startLine: number): string | undefined {
  const collected: string[] = [];
  // Clamp to the last real line — a symbol's reported startLine can exceed the
  // file's line count (e.g. synthetic/parser-reported ranges), and indexing past
  // the end yields `undefined`.
  const from = Math.min(startLine - 1, lines.length - 1);
  for (let i = from; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (t.length === 0) {
      if (collected.length > 0) break; // blank line ends the comment block
      continue;
    }
    if (
      t.startsWith("//") ||
      t.startsWith("/*") ||
      t.startsWith("*") ||
      t.endsWith("*/") ||
      t.startsWith("#")
    ) {
      collected.unshift(t.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?|^#\s?/g, "").trim());
    } else {
      break;
    }
  }
  const doc = collected.join("\n").trim();
  return doc.length > 0 ? doc.slice(0, 1000) : undefined;
}

/** Attach code slice, signature, and leading doc comment to each parsed symbol. */
function enrichSymbols(symbols: ParsedSymbol[], content: string): ParsedSymbol[] {
  const lines = content.split("\n");
  return symbols.map((s) => {
    const code = sliceCode(lines, s.startLine, s.endLine);
    const signature = firstSignificantLine(lines, s.startLine, s.endLine);
    const docComment = s.docComment ?? extractDocComment(lines, s.startLine);
    return {
      ...s,
      ...(code ? { code } : {}),
      ...(signature ? { signature } : {}),
      ...(docComment ? { docComment } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a source file and return a structured list of symbols, each enriched with
 * its signature, leading doc comment, and raw source slice for embedding.
 *
 * Markdown/MDX is parsed into heading-delimited sections (kind "heading"); code is
 * parsed via tree-sitter (TypeScript/JavaScript/Python).
 *
 * JS/JSX/MJS/CJS files are parsed with the TypeScript grammar (it handles them).
 *
 * @param filePath - Absolute or relative file path (used only for language
 *   detection via extension; the file is NOT read from disk).
 * @param content  - File contents as a string.
 */
export async function parseSourceFile(
  filePath: string,
  content: string,
): Promise<ParseResult> {
  const language = detectLanguage(filePath);

  if (language === "unknown") {
    return { language: "unknown", symbols: [] };
  }

  if (language === "markdown") {
    const { title, symbols } = parseMarkdown(content);
    return { language, symbols, ...(title ? { title } : {}) };
  }

  try {
    const parser = await getParser(language);
    const tree = parser.parse(content);

    if (language === "typescript") {
      const tsLang = parser.getLanguage();
      const rawSymbols = [
        ...runQueries(tree, tsLang, TS_QUERIES),
        ...runArrowQuery(tree, tsLang),
      ];

      // Deduplicate by (name + kind + startLine) to avoid double-counting
      // if multiple query patterns match the same node.
      const seenSymbols = new Set<string>();
      const deduped = rawSymbols.filter((s) => {
        const key = `${s.kind}:${s.name}:${s.startLine}`;
        if (seenSymbols.has(key)) return false;
        seenSymbols.add(key);
        return true;
      });

      // Extract call sites and import specifiers using the deduped symbols so
      // enclosingSymbol resolution uses the same set that will be returned.
      const calls = runCallQuery(tree, tsLang, deduped);
      const imports = runImportQuery(tree, tsLang);

      return { language, symbols: enrichSymbols(deduped, content), calls, imports };
    }

    // Python: symbol extraction only; call/import queries not yet implemented.
    const pyLang = parser.getLanguage();
    const pySymbols = runQueries(tree, pyLang, PY_QUERIES);

    // Deduplicate by (name + kind + startLine).
    const seenPy = new Set<string>();
    const dedupedPy = pySymbols.filter((s) => {
      const key = `${s.kind}:${s.name}:${s.startLine}`;
      if (seenPy.has(key)) return false;
      seenPy.add(key);
      return true;
    });

    return { language, symbols: enrichSymbols(dedupedPy, content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log at error level so WASM init failures and tree-sitter errors are
    // observable in production. Callers must also inspect result.error and
    // should not treat an empty symbols list as a successful parse.
    console.error(
      `[@oxagen/code-graph] parseSourceFile failed for "${filePath}" (language: ${language}): ${message}`,
    );
    return {
      language,
      symbols: [],
      error: message,
    };
  }
}
