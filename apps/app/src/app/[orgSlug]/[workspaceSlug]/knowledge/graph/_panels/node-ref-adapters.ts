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
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/semantic.edge.list";
import type { GraphNodeListOutput } from "@oxagen/oxagen/contracts/graph.node.list";
import type { GraphNodeSearchOutput } from "@oxagen/oxagen/contracts/graph.node.search";
import type { GraphSearchOutput } from "@oxagen/oxagen/contracts/graph.search";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import type { OntologyQueryOutput } from "@oxagen/oxagen/contracts/ontology.query";
import { primaryLabel } from "@/components/knowledge/graph-explorer/lib/transform";

/** graph.node.list ("list_nodes") row → citation. */
export function fromListNode(node: GraphNodeListOutput["nodes"][number]): KnowledgeNodeRef {
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
export function fromSearchNode(node: GraphNodeSearchOutput["nodes"][number]): KnowledgeNodeRef {
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
export function fromSemanticResult(result: GraphSearchOutput["results"][number]): KnowledgeNodeRef {
  return {
    id: result.nodeId,
    label: result.label,
    displayName: result.displayName,
    properties: {
      kind: result.kind,
      snippet: result.snippet,
      relevance: result.score,
      isSystem: result.isSystem,
    },
  };
}

/** ontology.neighbors ("get_ontology_neighbors") entry → citation. */
export function fromNeighbor(neighbor: OntologyNeighborsOutput["neighbors"][number]): KnowledgeNodeRef {
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
export function fromTraversedNode(node: OntologyQueryOutput["nodes"][number]): KnowledgeNodeRef {
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

/**
 * Best-effort detection of a node-shaped value inside an arbitrary
 * `run_cypher` result cell, so the Query console's result table can render a
 * `NodeRef` chip instead of a raw JSON blob when the query happens to
 * `RETURN` a node. Two shapes are recognized:
 *
 *  1. A raw Neo4j driver Node: `{ identity, labels: string[], properties }`
 *     (what `RETURN n` yields — see packages/handlers/src/graph.cypher.ts).
 *  2. A contract-shaped node ref: `{ id | nodeId | publicId, displayName,
 *     label? | labels? , properties? }` (what a projection like
 *     `RETURN n.publicId AS id, n.label AS label, n.displayName AS displayName`
 *     yields once destructured into a plain object).
 *
 * Returns `null` for anything else (scalars, arrays, plain objects without a
 * displayName) — the caller falls back to rendering the raw value.
 */
export function tryNodeRefFromCell(value: unknown): KnowledgeNodeRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  // Shape 1: raw Neo4j Node — `labels` is an array AND `properties` is an object.
  if (Array.isArray(v.labels) && v.properties && typeof v.properties === "object") {
    const props = v.properties as Record<string, unknown>;
    const label = typeof v.labels[0] === "string" ? (v.labels[0] as string) : "Node";
    const displayName =
      (typeof props.displayName === "string" && props.displayName) ||
      (typeof props.name === "string" && props.name) ||
      (typeof props.publicId === "string" && props.publicId) ||
      "Node";
    const id = typeof props.publicId === "string" ? props.publicId : null;
    return { id, label, displayName, properties: props };
  }

  // Shape 2: a contract-shaped ref — requires at least a string displayName.
  const displayName = v.displayName;
  if (typeof displayName !== "string") return null;
  const rawId = v.id ?? v.nodeId ?? v.publicId;
  if (typeof rawId !== "string" && rawId !== null && rawId !== undefined) return null;
  const label =
    typeof v.label === "string"
      ? v.label
      : Array.isArray(v.labels) && typeof v.labels[0] === "string"
        ? (v.labels[0] as string)
        : "Node";
  const properties =
    v.properties && typeof v.properties === "object" ? (v.properties as Record<string, unknown>) : {};
  return { id: (rawId as string | null | undefined) ?? null, label, displayName, properties };
}
