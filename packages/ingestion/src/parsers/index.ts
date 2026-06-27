/**
 * Source code parser — wraps tree-sitter to extract top-level symbols from
 * TypeScript and Python files.
 *
 * Returned symbols include name, kind, and 0-indexed line ranges suitable for
 * downstream Neo4j SourceSymbol nodes.
 */

import { extname } from "path";
import { getParser } from "./loader";
import { parseMarkdown } from "./markdown";
import type { ParseResult, ParsedSymbol, ParsedLanguage, SymbolKind } from "./types";

export type { ParseResult, ParsedSymbol, ParsedLanguage, SymbolKind };

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(filePath: string): ParsedLanguage {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
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
 * parsed via tree-sitter (TypeScript/Python).
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

    let symbols: ParsedSymbol[];

    if (language === "typescript") {
      const tsLang = parser.getLanguage();
      symbols = [
        ...runQueries(tree, tsLang, TS_QUERIES),
        ...runArrowQuery(tree, tsLang),
      ];
    } else {
      const pyLang = parser.getLanguage();
      symbols = runQueries(tree, pyLang, PY_QUERIES);
    }

    // Deduplicate by (name + kind + startLine) to avoid double-counting
    // if multiple query patterns match the same node.
    const seen = new Set<string>();
    const deduped = symbols.filter((s) => {
      const key = `${s.kind}:${s.name}:${s.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { language, symbols: enrichSymbols(deduped, content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log at error level so WASM init failures and tree-sitter errors are
    // observable in production. Callers must also inspect result.error and
    // should not treat an empty symbols list as a successful parse.
    console.error(
      `[ingestion/parsers] parseSourceFile failed for "${filePath}" (language: ${language}): ${message}`,
    );
    return {
      language,
      symbols: [],
      error: message,
    };
  }
}
