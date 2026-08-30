/**
 * graph_query core — assemble a structured context subgraph (Group 3).
 *
 * Given a natural-language query (and/or focus symbols), returns the impacted
 * files, the symbols and edges that connect them, and a coverage score — the
 * `GraphResult` the orchestrator hands to workers and the JSON the `graph_query`
 * tool returns. It fuses two signals:
 *
 *   - semantic: cosine-rank file nodes against the query embedding (when an
 *     embedding client is available), and
 *   - structural: resolve seed symbols by name and expand their n-hop
 *     neighbourhood / call-flow via the graph.
 *
 * Coverage is the max of the two confidences; below the configured threshold the
 * resolver reports a miss and the caller logs a grep fallback. This module is
 * pure over its injected `graph`/`client`/`store`, so it unit-tests without a
 * daemon, DuckDB, or the network.
 */
import type { CodeGraph, CodeNode } from "../../daemon/code-graph/types.js";
import type { CodeGraphStore } from "../../daemon/code-graph/store.js";
import type { EmbeddingClient } from "./embedding.js";
import type { GraphConfig } from "./config.js";
import {
  ensureFileEmbeddings,
  rankFilesBySimilarity,
  type RankedFile,
} from "./semantic-index.js";
import {
  resolveSeeds,
  expandNeighbourhood,
  callFlow,
  type Subgraph,
  type FlowDirection,
} from "./traversal.js";

/** A file the change is expected to touch. Matches the orchestrator's contract. */
export interface ImpactedFileRef {
  path: string;
  reason: string;
  rank?: number;
}

/** A symbol in the subgraph. Richer than the orchestrator contract (adds kind). */
export interface GraphSymbolRef {
  name: string;
  kind: string;
  file: string;
  line?: number;
}

/** An edge in the subgraph, endpoints resolved to human labels (not raw ids). */
export interface GraphEdgeRef {
  from: string;
  to: string;
  type: string;
}

/**
 * The structured graph result. Structurally assignable to the orchestrator's
 * `GraphResult` (its `symbols` require only `{name,file,line?}`); the extra
 * `kind` is additive.
 */
export interface GraphContextResult {
  impactedFiles: ImpactedFileRef[];
  symbols: GraphSymbolRef[];
  edges: GraphEdgeRef[];
  coverage: number;
  /** How the result was produced — surfaced in the debug log, not the contract. */
  source: "graph";
}

/** Options accepted by the query core (a superset of the resolver's input). */
export interface GraphQueryOptions {
  query: string;
  focusSymbols?: string[];
  maxNodes?: number;
  /** Degrees of separation to expand from each seed. Default 2. */
  hops?: number;
  /** When set, walk the execution flow of matched functions instead of a plain
   *  neighbourhood. "callers" answers "what invokes X"; "callees" "what X calls". */
  flow?: FlowDirection;
}

export interface RunGraphQueryParams {
  input: GraphQueryOptions;
  graph: CodeGraph;
  /** Absolute workspace root — used for lazy embedding of file content. */
  root: string;
  /** Embedding client, or null to run structural-only (lexical + traversal). */
  client: EmbeddingClient | null;
  store?: CodeGraphStore | null;
  config: GraphConfig;
}

const DEFAULT_HOPS = 2;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Human label for a node: a symbol's name, or a file's path. */
function labelOf(node: CodeNode | undefined): string | null {
  if (!node) return null;
  return node.kind === "file" ? node.path : node.name;
}

/**
 * Run the query and return the structured subgraph. Never throws for an empty
 * graph — it returns `coverage: 0` so the caller falls back cleanly.
 */
export async function runGraphQuery(
  params: RunGraphQueryParams,
): Promise<GraphContextResult> {
  const { input, graph, root, client, store, config } = params;
  const maxNodes = Math.max(
    1,
    Math.min(input.maxNodes ?? config.maxNodes, config.maxNodes),
  );
  const hops = Math.max(1, input.hops ?? DEFAULT_HOPS);

  // ── Semantic signal: rank file nodes by cosine to the query embedding. ──────
  let rankedFiles: RankedFile[] = [];
  if (client) {
    const { vectors } = await ensureFileEmbeddings({
      graph,
      root,
      client,
      store,
    });
    if (vectors.size > 0) {
      const queryVec = await client.embed(input.query);
      rankedFiles = rankFilesBySimilarity(graph, queryVec, vectors, maxNodes);
    }
  }
  const topSemantic = rankedFiles.length > 0 ? rankedFiles[0]!.score : 0;
  const semanticRankByPath = new Map(rankedFiles.map((r) => [r.path, r.score]));

  // ── Structural signal: resolve seed symbols and expand a bounded subgraph. ──
  const seeds = resolveSeeds(graph, {
    query: input.query,
    ...(input.focusSymbols ? { focusSymbols: input.focusSymbols } : {}),
  });
  const seedIds = seeds.map((s) => s.id);

  let subgraph: Subgraph = { nodes: [], edges: [] };
  if (seedIds.length > 0) {
    if (input.flow) {
      // Walk execution flow from every function-like seed, then union.
      const merged: Subgraph = { nodes: [], edges: [] };
      const nodeSeen = new Set<string>();
      for (const seed of seeds) {
        const flow = callFlow(graph, seed.id, {
          direction: input.flow,
          depth: hops,
          maxNodes,
        });
        for (const n of flow.nodes) {
          if (nodeSeen.has(n.id)) continue;
          nodeSeen.add(n.id);
          merged.nodes.push(n);
        }
        merged.edges.push(...flow.edges);
        if (merged.nodes.length >= maxNodes) break;
      }
      subgraph = merged;
    } else {
      subgraph = expandNeighbourhood(graph, seedIds, { hops, maxNodes });
    }
  }

  // ── Fuse into impacted files (semantic first, then structural). ─────────────
  const impacted = new Map<string, ImpactedFileRef>();
  const addFile = (path: string, reason: string, rank: number): void => {
    if (!impacted.has(path)) impacted.set(path, { path, reason, rank });
  };
  for (const rf of rankedFiles) {
    addFile(rf.path, `semantic match (${rf.score.toFixed(2)})`, rf.score);
  }
  // Every subgraph node — file OR symbol — implies an impacted file (a symbol's
  // path is its file). Group symbols per path for an informative reason. This is
  // what lets flow mode, whose subgraph is all functions, still name files.
  const symbolsPerFile = new Map<string, string[]>();
  const subgraphPaths = new Set<string>();
  for (const node of subgraph.nodes) {
    subgraphPaths.add(node.path);
    if (node.kind !== "file") {
      const list = symbolsPerFile.get(node.path) ?? [];
      list.push(node.name);
      symbolsPerFile.set(node.path, list);
    }
  }
  for (const path of subgraphPaths) {
    const syms = symbolsPerFile.get(path) ?? [];
    const reason =
      syms.length > 0
        ? `defines ${syms.slice(0, 3).join(", ")}${syms.length > 3 ? "…" : ""}`
        : "connected in the code graph";
    // Structural files rank below semantic ones; keep any existing semantic score.
    const rank = semanticRankByPath.get(path) ?? 0;
    addFile(path, reason, rank);
  }
  const impactedFiles = [...impacted.values()]
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .slice(0, maxNodes);

  // ── Symbols + edges from the subgraph, mapped to human labels. ──────────────
  const symbols: GraphSymbolRef[] = subgraph.nodes
    .filter((n) => n.kind !== "file")
    .slice(0, maxNodes)
    .map((n) => ({
      name: n.name,
      kind: n.kind,
      file: n.path,
      line: n.range.start,
    }));

  const edges: GraphEdgeRef[] = [];
  for (const e of subgraph.edges) {
    const from = labelOf(graph.nodes.get(e.source));
    const to = labelOf(graph.nodes.get(e.target));
    if (from === null || to === null) continue;
    edges.push({ from, to, type: e.type });
    if (edges.length >= maxNodes) break;
  }

  // ── Coverage: max of structural (name-anchored, high confidence) & semantic. ─
  const structural =
    seeds.length > 0 ? Math.min(0.95, 0.55 + 0.08 * seeds.length) : 0;
  const coverage =
    impactedFiles.length === 0 ? 0 : clamp01(Math.max(structural, topSemantic));

  return { impactedFiles, symbols, edges, coverage, source: "graph" };
}
