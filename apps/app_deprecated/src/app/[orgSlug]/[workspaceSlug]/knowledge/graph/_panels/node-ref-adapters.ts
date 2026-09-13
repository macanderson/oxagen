/**
 * node-ref-adapters.ts — pure mappers from each capability's node shape to
 * `KnowledgeNodeRef`, the one shape `NodeRef` (@/components/knowledge/graph/node-ref)
 * knows how to cite. Every capability invoked by this page's panels returns a
 * slightly different node projection (list_nodes: `labels: string[]`;
 * search_nodes/search_graph: `nodeId` + singular `label`; ontology.neighbors/
 * ontology.query: `nodeId` + `description`) — these adapters are the single
 * place that normalizes them, so no panel hand-rolls "never show a raw UUID"
 * logic on its own.
 */
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import type { GraphNodeListOutput } from "@oxagen/oxagen/contracts/graph.node.list";
import type { GraphNodeSearchOutput } from "@oxagen/oxagen/contracts/graph.node.search";
import type { GraphSearchOutput } from "@oxagen/oxagen/contracts/graph.search";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import type { OntologyQueryOutput } from "@oxagen/oxagen/contracts/ontology.query";
import { primaryLabel } from "@/components/knowledge/graph-explorer/lib/transform";

/** graph.node.list ("list_nodes") row → citation. */
export function fromListNode(
  node: GraphNodeListOutput["nodes"][number],
): KnowledgeNodeRef {
  return {
    id: node.id,
    // list_nodes returns labels as [base "KnowledgeNode", domain] — cite by the
    // domain label, never the base marker (matches the canvas/table adapter's
    // primaryLabel, so `labels[0]` doesn't paint every chip "KnowledgeNode").
    label: primaryLabel(node.labels),
    displayName: node.displayName,
    properties: node.properties ?? {},
  };
}

/** graph.node.search ("search_nodes") row → citation. Carries the fuzzy-match score for display. */
export function fromSearchNode(
  node: GraphNodeSearchOutput["nodes"][number],
): KnowledgeNodeRef {
  return {
    id: node.nodeId,
    label: node.label,
    displayName: node.displayName,
    properties: {
      ...(node.description ? { description: node.description } : {}),
      matchScore: node.score,
    },
  };
}

/** graph.search ("search_graph") result → citation. Carries kind + snippet + relevance. */
export function fromSemanticResult(
  result: GraphSearchOutput["results"][number],
): KnowledgeNodeRef {
  return {
    id: result.nodeId,
    label: result.label,
    displayName: result.displayName,
    properties: {
      kind: result.kind,
      snippet: result.snippet,
      relevance: result.score,
    },
  };
}

/** ontology.neighbors ("get_ontology_neighbors") entry → citation. */
export function fromNeighbor(
  neighbor: OntologyNeighborsOutput["neighbors"][number],
): KnowledgeNodeRef {
  return {
    id: neighbor.nodeId,
    label: neighbor.label,
    displayName: neighbor.displayName,
    properties: {
      ...(neighbor.description ? { description: neighbor.description } : {}),
      edgeType: neighbor.edgeType,
      direction: neighbor.direction,
    },
  };
}

/** ontology.query ("query_ontology") reachable node → citation. */
export function fromTraversedNode(
  node: OntologyQueryOutput["nodes"][number],
): KnowledgeNodeRef {
  return {
    id: node.nodeId,
    label: node.label,
    displayName: node.displayName,
    properties: {
      ...(node.description ? { description: node.description } : {}),
      depth: node.depth,
    },
  };
}
