/**
 * Graph-context contract (pipeline Group 3 — not yet built).
 *
 * Graph before grep: the coordinator always tries the knowledge-graph query
 * first and only falls back to a grep/file scan on a miss — logging the
 * fallback so it's visible in `oxagen logs`.
 *
 * This is a fresh, standalone stub: Group 3 has not landed in this worktree,
 * so there is no shipped implementation to reconcile against yet. It is kept
 * intentionally independent of `src/context` (which does not exist here) and
 * of orchestrator's own interim mirror of this shape (see `./orchestrator.ts`'s
 * header) — Group 3 implements against this file when it lands.
 */
export interface GraphQueryInput {
  query: string;
  focusSymbols?: string[];
  maxNodes?: number;
}

export interface ImpactedFile {
  path: string;
  reason: string;
  rank?: number;
}

export interface GraphSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "const" | "type";
  file: string;
  line?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "calls" | "imports" | "implements" | "references";
}

export interface GraphResult {
  impactedFiles: ImpactedFile[];
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  /** 0..1. Below the configured threshold, the resolver falls back to grep. */
  coverage: number;
}

export interface ContextResolver {
  /** Always tries the graph first. Only calls grep/scan on a miss, and logs it. */
  query(input: GraphQueryInput): Promise<GraphResult>;
  /** Returns true if the graph answered; false means a logged fallback happened. */
  usedGraph(): boolean;
}
