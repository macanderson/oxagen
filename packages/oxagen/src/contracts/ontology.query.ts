import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";
import {
  asOfField,
  asKnownAtField,
  edgeValiditySchema,
} from "../lib/temporal-query";

/**
 * ontology.query — first-class, typed multi-hop traversal over the knowledge
 * customer-context graph. The caller never writes Cypher: they name a
 * start node, the relationship type(s) to follow, a direction, and a depth, and
 * the handler walks the graph (org + workspace scoped) and returns the reachable
 * subgraph as nodes + edges. This is the safe, agent-callable traversal primitive
 * that powers relationship-condition triggers and graph reasoning.
 */

const ontologyDirection = z
  .enum(["out", "in", "both"])
  .describe(
    "Direction to traverse relative to each node: 'out' follows outgoing edges, 'in' incoming, 'both' either.",
  );

const traversedNode = z.object({
  nodeId: z.string().describe("publicId of the node"),
  label: z.string().describe("Domain label (e.g. Issue, Topic)"),
  displayName: z.string(),
  description: z.string().nullable(),
  depth: z
    .number()
    .int()
    .describe("Hop distance from the start node (0 = start node)"),
});

const traversedEdge = z
  .object({
    fromNodeId: z.string().describe("publicId of the source node"),
    toNodeId: z.string().describe("publicId of the target node"),
    edgeType: z
      .string()
      .regex(RELATIONSHIP_TYPE_PATTERN)
      .describe("Relationship type of this edge"),
  })
  // Bi-temporal validity of the edge, so a grounded answer can cite "true as of X".
  .merge(edgeValiditySchema);

export const ontologyQuery = registerCapability({
  name: "query_ontology",
  domain: "ontology",
  description:
    "Multi-hop traversal FROM a known start node over named relationship type(s) to a given depth (1–5); " +
    "returns the reachable customer-context subgraph (nodes + edges), org + workspace scoped, read-only, no Cypher required. " +
    "Prefer over ontology.neighbors when you need MORE than one hop. This tool discovers CONNECTIONS, not " +
    "nodes: it requires a startNodeId you already have — do NOT use it to find a node by name, topic, or " +
    "keyword (use graph.search for semantic lookup or graph.node.search for name/label lookup first).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    startNodeId: z
      .string()
      .describe("publicId of the node to start the traversal from"),
    edgeTypes: z
      .array(z.string().regex(RELATIONSHIP_TYPE_PATTERN))
      .optional()
      .describe(
        "Relationship type(s) to follow. Each must match [A-Z][A-Z0-9_]{0,62}. When omitted, the " +
          "pinned schema's active-vocabulary relationship types are traversed (or all types when none pinned).",
      ),
    direction: ontologyDirection.default("out"),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .describe("Maximum hop distance to traverse (1–5, default 2)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        "Maximum number of reachable nodes to return (1–500, default 100)",
      ),
    asOf: asOfField,
    asKnownAt: asKnownAtField,
  }),
  output: z.object({
    startNode: traversedNode
      .nullable()
      .describe(
        "The start node, or null if it does not exist in this org + workspace",
      ),
    nodes: z
      .array(traversedNode)
      .describe(
        "Reachable nodes including the start node (depth 0), deduplicated by nodeId",
      ),
    edges: z
      .array(traversedEdge)
      .describe("Edges traversed between the returned nodes"),
    truncated: z
      .boolean()
      .describe(
        "True when the result was capped by `limit` and more nodes were reachable",
      ),
  }),
});

export type OntologyQueryInput = z.output<typeof ontologyQuery.input>;
export type OntologyQueryOutput = z.output<typeof ontologyQuery.output>;
