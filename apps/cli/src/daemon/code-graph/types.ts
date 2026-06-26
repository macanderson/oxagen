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
  | "interface";

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
