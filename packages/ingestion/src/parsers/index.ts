/**
 * Source code parser — wraps tree-sitter to extract top-level symbols from
 * TypeScript and Python files.
 *
 * Returned symbols include name, kind, and 0-indexed line ranges suitable for
 * downstream Neo4j SourceSymbol nodes.
 */

import { extname } from "path";
import { getParser } from "./loader";
import type { ParseResult, ParsedSymbol, SymbolKind } from "./types";

export type { ParseResult, ParsedSymbol, SymbolKind };

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(
  filePath: string,
): "typescript" | "python" | "unknown" {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".py") return "python";
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a source file and return a structured list of symbols.
 *
 * @param filePath - Absolute or relative file path (used only for language
 *   detection via extension; the file is NOT read from disk).
 * @param content  - Source file contents as a string.
 */
export async function parseSourceFile(
  filePath: string,
  content: string,
): Promise<ParseResult> {
  const language = detectLanguage(filePath);

  if (language === "unknown") {
    return { language: "unknown", symbols: [] };
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

    return { language, symbols: deduped };
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
