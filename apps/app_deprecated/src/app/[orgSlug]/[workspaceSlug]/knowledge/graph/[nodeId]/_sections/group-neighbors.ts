/**
 * group-neighbors.ts — pure grouping helper for the node-detail Neighbors
 * section (spec: docs/web-app-2.0/workspace/knowledge/graph/node/spec.md).
 *
 * ontology.neighbors (get_ontology_neighbors) returns a flat list of adjacent
 * nodes; the UI wants them grouped by relationship "shape" — the relationship
 * type AND the direction it runs relative to the node being viewed — so the
 * Neighbors section can render one heading per group ("WORKS_AT →" vs
 * "← WORKS_AT") instead of one undifferentiated list. Direction is kept in
 * the grouping key deliberately: the same relationship type can point both
 * out (this node → X) and in (Y → this node) at once, and collapsing those
 * together would blur which way the edge runs.
 *
 * Pure + node-testable, mirroring the graph-explorer's lib/* helpers.
 */
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";

export type NeighborEntry = OntologyNeighborsOutput["neighbors"][number];

export interface NeighborGroup {
  /** Stable identity for React keys and sort order: `${edgeType}:${direction}`. */
  key: string;
  edgeType: string;
  direction: "out" | "in";
  neighbors: NeighborEntry[];
}

/**
 * Group neighbors by (relationshipType, direction). Groups are sorted by
 * edgeType then direction ("in" before "out") so the section renders
 * deterministically across requests; within a group, entries keep the order
 * ontology.neighbors returned them (displayName ASC).
 */
export function groupNeighborsByType(
  neighbors: readonly NeighborEntry[],
): NeighborGroup[] {
  const groups = new Map<string, NeighborGroup>();

  for (const neighbor of neighbors) {
    const key = `${neighbor.edgeType}:${neighbor.direction}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        edgeType: neighbor.edgeType,
        direction: neighbor.direction,
        neighbors: [],
      };
      groups.set(key, group);
    }
    group.neighbors.push(neighbor);
  }

  return [...groups.values()].sort((a, b) => {
    const byType = a.edgeType.localeCompare(b.edgeType);
    if (byType !== 0) return byType;
    return a.direction.localeCompare(b.direction);
  });
}
