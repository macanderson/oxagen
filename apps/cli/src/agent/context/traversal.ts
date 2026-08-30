/**
 * Graph traversal for the context layer (Group 3).
 *
 * Turns a handful of *seed* nodes into a self-contained subgraph the LLM can
 * reason over in ONE tool call — the whole point of graph-before-grep. Two
 * shapes drive almost every "understand this code" question:
 *
 *   - n-hop neighbourhood: a node plus everything within N degrees of separation
 *     via any edge (imports, calls, contains, references). "Pull processPayment
 *     and everything connected to it."
 *   - execution flow: the transitive callers/callees of a function. "What invokes
 *     payment processing?" / "what does it call?"
 *
 * Seeds are resolved from explicit `focusSymbols` and/or the lexical tokens of a
 * natural-language query, so the tool works with or without an embedding client.
 * Expansion is breadth-first and hard-capped at `maxNodes` so a query on a hub
 * file can't return the whole repo.
 *
 * The neighbourhood/flow primitives ({@link callers}, {@link callees}) come from
 * the daemon's `query.ts`; this module composes them and bounds the result.
 */
import {
  callers,
  callees,
  searchSymbols,
} from "../../daemon/code-graph/query.js";
import type {
  CodeGraph,
  CodeNode,
  CodeEdge,
  CodeEdgeType,
} from "../../daemon/code-graph/types.js";

/** A bounded subgraph: the nodes reached and the edges that connect them. */
export interface Subgraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

/** Direction of an execution-flow walk. */
export type FlowDirection = "callers" | "callees" | "both";

/**
 * Split a natural-language / identifier query into lowercase lexical tokens,
 * breaking camelCase and snake/kebab boundaries so "processPayment" and
 * "payment processor" both surface a `processPayment` symbol. Tokens shorter
 * than 3 chars are dropped as too noisy to seed on.
 */
export function tokenize(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
}

/**
 * Resolve seed nodes from explicit focus symbols and the query's lexical tokens.
 * Exact/prefix/substring symbol-name matches (via {@link searchSymbols}) are the
 * deterministic backbone of the result — they work offline and give the tool a
 * high-confidence anchor even when semantic ranking is unavailable.
 */
export function resolveSeeds(
  graph: CodeGraph,
  opts: { query?: string; focusSymbols?: string[]; perTermLimit?: number },
): CodeNode[] {
  const perTerm = opts.perTermLimit ?? 5;
  const seen = new Set<string>();
  const seeds: CodeNode[] = [];
  const add = (n: CodeNode | undefined): void => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    seeds.push(n);
  };

  for (const sym of opts.focusSymbols ?? []) {
    for (const hit of searchSymbols(graph, sym, perTerm)) add(hit);
  }
  if (opts.query) {
    for (const term of tokenize(opts.query)) {
      for (const hit of searchSymbols(graph, term, perTerm)) add(hit);
    }
  }
  return seeds;
}

/** The file node that contains a symbol (via the reverse `contains` edge). */
function containingFile(
  graph: CodeGraph,
  symbolId: string,
): CodeNode | undefined {
  for (const e of graph.edges) {
    if (e.type === "contains" && e.target === symbolId) {
      const f = graph.nodes.get(e.source);
      if (f?.kind === "file") return f;
    }
  }
  return undefined;
}

/**
 * Breadth-first expansion of `seedIds` out to `hops` degrees of separation,
 * following the given edge types (any type when omitted), capped at `maxNodes`
 * total nodes. Also pulls in each seed symbol's containing file so the result is
 * grounded in real files. Deterministic: edges are visited in graph order.
 */
export function expandNeighbourhood(
  graph: CodeGraph,
  seedIds: string[],
  opts: { hops: number; edgeTypes?: CodeEdgeType[]; maxNodes: number },
): Subgraph {
  const included = new Set<string>();
  const resultEdges: CodeEdge[] = [];
  const edgeSeen = new Set<string>();

  const addNode = (id: string): boolean => {
    if (included.has(id)) return true;
    if (included.size >= opts.maxNodes) return false;
    included.add(id);
    return true;
  };

  // Seed the frontier with the seeds and their containing files.
  let frontier: string[] = [];
  for (const id of seedIds) {
    if (!addNode(id)) break;
    frontier.push(id);
    const file = containingFile(graph, id);
    if (file && addNode(file.id)) frontier.push(file.id);
  }

  const typeOk = (t: CodeEdgeType): boolean =>
    !opts.edgeTypes || opts.edgeTypes.includes(t);
  const recordEdge = (e: CodeEdge): void => {
    const key = `${e.source}->${e.target}:${e.type}`;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      resultEdges.push(e);
    }
  };

  for (let hop = 0; hop < opts.hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.edges) {
        if (!typeOk(e.type)) continue;
        let other: string | null = null;
        if (e.source === id) other = e.target;
        else if (e.target === id) other = e.source;
        if (other === null) continue;
        const had = included.has(other);
        if (!had && !addNode(other)) continue; // cap hit — stop widening
        recordEdge(e);
        if (!had) next.push(other);
      }
      if (included.size >= opts.maxNodes) break;
    }
    frontier = next;
  }

  // Backfill any edge whose BOTH endpoints are already included (so the subgraph
  // is internally complete, not just a spanning tree).
  for (const e of graph.edges) {
    if (typeOk(e.type) && included.has(e.source) && included.has(e.target))
      recordEdge(e);
  }

  const nodes: CodeNode[] = [];
  for (const id of included) {
    const n = graph.nodes.get(id);
    if (n) nodes.push(n);
  }
  return { nodes, edges: resultEdges };
}

/**
 * The transitive execution flow around a function: its callers (who invokes it),
 * its callees (what it invokes), or both, out to `depth` levels and capped at
 * `maxNodes`. Reuses {@link callers}/{@link callees} at each level.
 */
export function callFlow(
  graph: CodeGraph,
  functionId: string,
  opts: { direction: FlowDirection; depth: number; maxNodes: number },
): Subgraph {
  const included = new Set<string>([functionId]);
  const edges: CodeEdge[] = [];
  const edgeSeen = new Set<string>();
  const recordCall = (from: string, to: string): void => {
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ source: from, target: to, type: "calls" });
  };

  let frontier = [functionId];
  for (let d = 0; d < opts.depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (opts.direction === "callers" || opts.direction === "both") {
        for (const c of callers(graph, id)) {
          recordCall(c.id, id);
          if (!included.has(c.id) && included.size < opts.maxNodes) {
            included.add(c.id);
            next.push(c.id);
          }
        }
      }
      if (opts.direction === "callees" || opts.direction === "both") {
        for (const c of callees(graph, id)) {
          recordCall(id, c.id);
          if (!included.has(c.id) && included.size < opts.maxNodes) {
            included.add(c.id);
            next.push(c.id);
          }
        }
      }
    }
    frontier = next;
  }

  const nodes: CodeNode[] = [];
  for (const id of included) {
    const n = graph.nodes.get(id);
    if (n) nodes.push(n);
  }
  return { nodes, edges };
}
