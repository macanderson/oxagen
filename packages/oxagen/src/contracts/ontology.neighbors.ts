import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";
import {
  asOfField,
  asKnownAtField,
  edgeValiditySchema,
} from "../lib/temporal-query";

/**
 * get_ontology_neighbors — the one-hop neighborhood of a node. A focused, cheap
 * traversal primitive (depth 1) for "what is directly connected to X?" without
 * the caller writing Cypher. Customer-context only, org + workspace scoped,
 * and read-only. Pairs with `query_ontology` for deeper multi-hop walks.
 */

const ontologyDirection = z
  .enum(["out", "in", "both"])
  .describe(
    "Direction of neighbors to return relative to the node: 'out' for targets of outgoing edges, " +
      "'in' for sources of incoming edges, 'both' for either.",
  );

const neighborEntry = z
  .object({
    nodeId: z.string().describe("publicId of the neighbor node"),
    label: z.string().describe("Domain label of the neighbor"),
    displayName: z.string(),
    description: z.string().nullable(),
    edgeType: z
      .string()
      .regex(RELATIONSHIP_TYPE_PATTERN)
      .describe("Relationship type connecting the node to this neighbor"),
    direction: z
      .enum(["out", "in"])
      .describe(
        "'out' if the edge points from the node to this neighbor; 'in' if from the neighbor to the node",
      ),
  })
  // Bi-temporal validity of the connecting edge, so the citation can show "true as of X".
  .merge(edgeValiditySchema);

export const ontologyNeighbors = registerCapability({
  name: "get_ontology_neighbors",
  domain: "ontology",
  description:
    "Return the one-hop neighborhood of a node — directly connected nodes, optionally filtered by " +
    "relationship type and direction. Customer-context only, org + workspace scoped. Read-only; no Cypher required.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  // Accountability chain: a graph read acts on a specific node — record it on
  // the audit row so "who has read node N" is queryable (target_kind/target_id).
  audit: { targetKind: "graph.node", targetIdField: "nodeId" },
  input: z.object({
    nodeId: z
      .string()
      .describe("publicId of the node whose neighbors to fetch"),
    edgeTypes: z
      .array(z.string().regex(RELATIONSHIP_TYPE_PATTERN))
      .optional()
      .describe(
        "Relationship type(s) to include. Each must match [A-Z][A-Z0-9_]{0,62}. When omitted, " +
          "the pinned schema's active-vocabulary relationship types are used (or all types when none pinned).",
      ),
    direction: ontologyDirection.default("both"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of neighbors to return (1–500, default 100)"),
    asOf: asOfField,
    asKnownAt: asKnownAtField,
  }),
  output: z.object({
    nodeId: z.string().describe("publicId echoed back from the request"),
    found: z
      .boolean()
      .describe("True if the node exists in this org + workspace"),
    neighbors: z.array(neighborEntry).describe("Directly connected nodes"),
    truncated: z
      .boolean()
      .describe(
        "True when the result was capped by `limit` and more neighbors exist",
      ),
  }),
});

export type OntologyNeighborsInput = z.output<typeof ontologyNeighbors.input>;
export type OntologyNeighborsOutput = z.output<typeof ontologyNeighbors.output>;
