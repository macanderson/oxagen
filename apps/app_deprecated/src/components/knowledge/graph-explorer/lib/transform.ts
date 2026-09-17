/**
 * transform.ts — pure mappers between the wired graph capabilities and the
 * explorer's wire shapes, plus subgraph merge/degree maths.
 *
 * Kept free of React and of the contract packages (local minimal input
 * interfaces) so it is node-testable and safe in the client bundle. Used by
 * both the `/api/v1/graph/explore` route handler (to assemble payloads) and the
 * client (to merge `expand` results into the live graph).
 */

import type { ExplorerEdge, ExplorerNode, TypeCount } from "../types";

/** Minimal shape of a `graph.node.list` / `graph.node.get` row. */
export interface ListedNodeLike {
  id: string;
  labels: string[];
  properties?: Record<string, unknown>;
  displayName: string;
  sourceId?: string;
  createdAt?: string;
  description?: string | null;
}

/** Minimal shape of an `ontology.neighbors` neighbor entry. */
export interface NeighborLike {
  nodeId: string;
  label: string;
  displayName: string;
  description?: string | null;
  edgeType: string;
  direction: "in" | "out";
}

/**
 * Pick the most meaningful domain label from a labels array. `graph.node.list`
 * returns `["KnowledgeNode", "<Domain>"]`; the base "KnowledgeNode" marker is
 * never useful for display, so prefer the first non-base label.
 */
export function primaryLabel(labels: string[]): string {
  const domain = labels.find((l) => l && l !== "KnowledgeNode");
  return domain ?? labels[0] ?? "Node";
}

/** Map a hydrated `graph.node.*` row to an ExplorerNode (degree filled later). */
export function nodeFromListed(raw: ListedNodeLike): ExplorerNode {
  return {
    id: raw.id,
    label: primaryLabel(raw.labels),
    displayName: raw.displayName,
    description: raw.description ?? null,
    properties: raw.properties ?? {},
    ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
    ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
    degree: 0,
    hydrated: true,
  };
}

/** Map an `ontology.neighbors` neighbor to a stub ExplorerNode (not hydrated). */
export function nodeFromNeighbor(raw: NeighborLike): ExplorerNode {
  return {
    id: raw.nodeId,
    label: raw.label,
    displayName: raw.displayName,
    description: raw.description ?? null,
    degree: 0,
    hydrated: false,
  };
}

/** Stable synthetic edge id so the same relationship dedupes across merges. */
export function edgeId(source: string, target: string, type: string): string {
  return `${source}->${target}:${type}`;
}

/** Build confirmed edges from a node's neighbor walk, anchored at `anchorId`. */
export function edgesFromNeighbors(
  anchorId: string,
  neighbors: NeighborLike[],
): ExplorerEdge[] {
  return neighbors.map((n) => {
    const [source, target] =
      n.direction === "out" ? [anchorId, n.nodeId] : [n.nodeId, anchorId];
    return {
      id: edgeId(source, target, n.edgeType),
      source,
      target,
      type: n.edgeType,
      inferred: false,
    };
  });
}

/**
 * Merge `incoming` nodes into `base`, deduped by id. A hydrated node always
 * wins over a stub so a later detail fetch upgrades an earlier neighbor stub.
 */
export function mergeNodes(
  base: ExplorerNode[],
  incoming: ExplorerNode[],
): ExplorerNode[] {
  const byId = new Map<string, ExplorerNode>();
  for (const n of base) byId.set(n.id, n);
  for (const n of incoming) {
    const existing = byId.get(n.id);
    if (!existing) {
      byId.set(n.id, n);
    } else if (n.hydrated && !existing.hydrated) {
      // Upgrade the stub but preserve any degree already computed.
      byId.set(n.id, { ...n, degree: existing.degree });
    }
  }
  return [...byId.values()];
}

/** Merge `incoming` edges into `base`, deduped by synthetic id. */
export function mergeEdges(
  base: ExplorerEdge[],
  incoming: ExplorerEdge[],
): ExplorerEdge[] {
  const byId = new Map<string, ExplorerEdge>();
  for (const e of base) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * Drop edges whose endpoints are not both present in the node set, then set
 * each node's `degree` to its edge count within the surviving set. Returns the
 * pruned edges alongside the degree-annotated nodes.
 */
export function reconcile(
  nodes: ExplorerNode[],
  edges: ExplorerEdge[],
): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const present = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter(
    (e) => present.has(e.source) && present.has(e.target),
  );

  const degree = new Map<string, number>();
  for (const e of keptEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const degreedNodes = nodes.map((n) => ({
    ...n,
    degree: degree.get(n.id) ?? 0,
  }));
  return { nodes: degreedNodes, edges: keptEdges };
}

/** Count nodes by domain label, descending. */
export function countNodesByLabel(nodes: ExplorerNode[]): TypeCount[] {
  return tally(nodes.map((n) => n.label));
}

/** Count edges by relationship type, descending. */
export function countEdgesByType(edges: ExplorerEdge[]): TypeCount[] {
  return tally(edges.map((e) => e.type));
}

/** Convert a `Record<string, number>` (e.g. `graph.stats.nodesByLabel`) → sorted TypeCount[]. */
export function recordToCounts(
  record: Record<string, number> | undefined,
): TypeCount[] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([type]) => type && type !== "KnowledgeNode")
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

function tally(values: string[]): TypeCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
