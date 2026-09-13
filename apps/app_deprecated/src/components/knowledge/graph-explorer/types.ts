/**
 * types.ts — shared contract between the graph-explorer client surface and the
 * `/api/v1/graph/explore` route handler.
 *
 * The explorer never talks to Neo4j directly. It exchanges these plain JSON
 * shapes with the route handler, which composes the wired graph capabilities
 * (`graph.stats`, `graph.node.list`, `graph.node.search`, `graph.node.get`,
 * `ontology.neighbors`) server-side. Keeping the wire
 * shapes here means the route handler and the React tree share one source of
 * truth and can never drift.
 */

/** A node as rendered in the explorer (graph + table + detail). */
export interface ExplorerNode {
  /** publicId — the stable, user-facing identifier (Neo4j `publicId`). */
  id: string;
  /** Domain label, e.g. "Issue", "Topic", "Document". */
  label: string;
  /** Human-readable name shown on the graph and in tables. */
  displayName: string;
  description?: string | null;
  /** Full property bag. Present once the node has been hydrated (seed/detail). */
  properties?: Record<string, unknown>;
  /** Source connector id, when the node originated from an ingestion. */
  sourceId?: string;
  createdAt?: string;
  /** Connectivity within the current view — drives size + "super node" ranking. */
  degree: number;
  /** True once full properties have been hydrated (vs. a stub from a neighbor walk). */
  hydrated: boolean;
}

/** Relationship between two nodes. */
export interface ExplorerEdge {
  /** Synthetic, stable id: `${source}->${target}:${type}`. */
  id: string;
  source: string;
  target: string;
  /** Relationship type (graph edge type or inferred relationship label). */
  type: string;
  /** True for LLM-inferred semantic edges, false for confirmed graph edges. */
  inferred: boolean;
  /** Inference confidence 0..1 — only present for inferred edges. */
  confidence?: number;
}

/** A `{ type, count }` tuple used by the visibility/filter panel. */
export interface TypeCount {
  type: string;
  count: number;
}

export interface ExplorerStats {
  nodeCount: number;
  edgeCount: number;
  inferredEdgeCount: number;
  /** Node counts keyed by domain label, descending by count. */
  nodesByLabel: TypeCount[];
  /** Edge counts keyed by relationship type, descending by count. */
  edgesByType: TypeCount[];
}

/** Response for the `graph` op — the initial seeded subgraph. */
export interface ExplorerGraphPayload {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  stats: ExplorerStats;
  /** True when more nodes exist than were seeded into the view. */
  truncated: boolean;
}

/** Response for the `expand` op — a single node's neighborhood. */
export interface ExplorerExpandPayload {
  found: boolean;
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
}

/** Response for the `nodes` op — the paginated table view. */
export interface ExplorerNodesPayload {
  nodes: ExplorerNode[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** Response for the `search` op — semantic/text search hits. */
export interface ExplorerSearchPayload {
  nodes: ExplorerNode[];
}

/** A directly-connected neighbor, shown in the node detail panel. */
export interface ExplorerNeighbor {
  nodeId: string;
  label: string;
  displayName: string;
  edgeType: string;
  direction: "in" | "out";
}

/** Response for the `node` op — full detail for the detail panel. */
export interface ExplorerNodeDetailPayload {
  node: ExplorerNode | null;
  neighbors: ExplorerNeighbor[];
}

// ---------------------------------------------------------------------------
// Request bodies (discriminated by `op`). orgSlug/workspaceSlug identify the
// tenant; the route handler still asserts membership before honouring them.
// ---------------------------------------------------------------------------

interface BaseRequest {
  orgSlug: string;
  workspaceSlug: string;
}

export type ExploreRequest = BaseRequest &
  (
    | {
        op: "graph";
        labels?: string[];
        limit?: number;
      }
    | { op: "expand"; nodeId: string }
    | {
        op: "nodes";
        labels?: string[];
        query?: string;
        limit?: number;
        offset?: number;
      }
    | { op: "search"; query: string; labels?: string[] }
    | { op: "node"; nodeId: string }
  );

export type ExploreView = "2d" | "3d" | "table";
