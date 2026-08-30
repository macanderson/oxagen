/**
 * Code graph query API — answers structural questions about the codebase.
 */
import type {
  CodeGraph,
  CodeNode,
  CodeEdge,
  CodeEdgeType,
  GraphQueryResult,
} from "./types";

/**
 * Get k-hop neighbors of a node.
 */
export function neighbors(
  graph: CodeGraph,
  nodeId: string,
  hops = 1,
  edgeTypes?: CodeEdgeType[],
): GraphQueryResult {
  const visitedNodes = new Set<string>();
  const resultEdges: CodeEdge[] = [];
  let frontier = new Set([nodeId]);

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier = new Set<string>();

    for (const id of frontier) {
      visitedNodes.add(id);

      for (const edge of graph.edges) {
        if (edgeTypes && !edgeTypes.includes(edge.type)) continue;

        if (edge.source === id && !visitedNodes.has(edge.target)) {
          nextFrontier.add(edge.target);
          resultEdges.push(edge);
        }
        if (edge.target === id && !visitedNodes.has(edge.source)) {
          nextFrontier.add(edge.source);
          resultEdges.push(edge);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Add final frontier to visited
  for (const id of frontier) visitedNodes.add(id);

  const nodes = [...visitedNodes]
    .map((id) => graph.nodes.get(id))
    .filter((n): n is CodeNode => n !== undefined);

  return { nodes, edges: resultEdges };
}

/**
 * Find all callers of a function.
 */
export function callers(graph: CodeGraph, functionId: string): CodeNode[] {
  const callerIds = graph.edges
    .filter((e) => e.target === functionId && e.type === "calls")
    .map((e) => e.source);

  return callerIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is CodeNode => n !== undefined);
}

/**
 * Find all callees of a function.
 */
export function callees(graph: CodeGraph, functionId: string): CodeNode[] {
  const calleeIds = graph.edges
    .filter((e) => e.source === functionId && e.type === "calls")
    .map((e) => e.target);

  return calleeIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is CodeNode => n !== undefined);
}

/**
 * Find all files that a given file imports.
 */
export function imports(graph: CodeGraph, fileId: string): CodeNode[] {
  const importedIds = graph.edges
    .filter((e) => e.source === fileId && e.type === "imports")
    .map((e) => e.target);

  return importedIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is CodeNode => n !== undefined);
}

/**
 * Find all files that depend on (import) a given file.
 */
export function dependents(graph: CodeGraph, fileId: string): CodeNode[] {
  const depIds = graph.edges
    .filter((e) => e.target === fileId && e.type === "imports")
    .map((e) => e.source);

  return depIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is CodeNode => n !== undefined);
}

/**
 * Fuzzy symbol search across the code graph.
 */
export function searchSymbols(
  graph: CodeGraph,
  pattern: string,
  limit = 20,
): CodeNode[] {
  const lower = pattern.toLowerCase();
  const results: Array<{ node: CodeNode; score: number }> = [];

  for (const node of graph.nodes.values()) {
    if (node.kind === "file") continue; // Skip file nodes in symbol search
    const name = node.name.toLowerCase();
    if (name.includes(lower)) {
      // Score: exact match > prefix > contains
      const score = name === lower ? 3 : name.startsWith(lower) ? 2 : 1;
      results.push({ node, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.node);
}
