/**
 * Code graph entity types — nodes and edges representing code structure.
 */

export type CodeNodeKind =
  | "file"
  | "function"
  | "class"
  | "method"
  | "variable"
  | "import"
  | "export"
  | "type"
  | "interface"
  | "arrow_function";

export interface CodeNode {
  /** Content-addressed: hash of path + name + kind. */
  id: string;
  kind: CodeNodeKind;
  name: string;
  /** File path relative to workspace root. */
  path: string;
  /** Line range in the file. */
  range: { start: number; end: number };
  language: string;
  /** Function/method signature if applicable. */
  signature?: string;
  /** JSDoc/docstring if present. */
  docstring?: string;
  /**
   * LLM-inferred application domain (e.g. "payments", "auth", "billing").
   * Set by graph push via inferDomains() and propagated to both DuckDB
   * (local persistence) and Neo4j (workspace knowledge graph).
   */
  domain?: string;
  /**
   * Semantic embedding of this node's rendered text (Group 3 context layer).
   * Present only on file nodes today — the unit the `graph_query` tool ranks
   * for "impacted files" — and only once the semantic index has embedded it.
   * The producing provider is recorded in {@link embeddingProvider} so a
   * provider swap re-embeds rather than comparing incompatible vectors.
   */
  embedding?: number[];
  /** Id of the {@link embedding} provider (e.g. "local-hash-v1"), or undefined. */
  embeddingProvider?: string;
}

export type CodeEdgeType =
  | "calls"
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "contains"
  | "references";

export interface CodeEdge {
  source: string;   // CodeNode ID
  target: string;   // CodeNode ID
  type: CodeEdgeType;
}

export interface CodeGraph {
  nodes: Map<string, CodeNode>;
  edges: CodeEdge[];
}

export interface GraphQueryResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
}
