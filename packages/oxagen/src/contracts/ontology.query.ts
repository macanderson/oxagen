import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

/**
 * ontology.query — first-class, typed multi-hop traversal over the knowledge
 * graph. Unlike `graph.cypher`, the caller never writes Cypher: they name a
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
  depth: z.number().int().describe("Hop distance from the start node (0 = start node)"),
});

const traversedEdge = z.object({
  fromNodeId: z.string().describe("publicId of the source node"),
  toNodeId: z.string().describe("publicId of the target node"),
  edgeType: z
    .string()
    .regex(RELATIONSHIP_TYPE_PATTERN)
    .describe("Relationship type of this edge"),
});

export const ontologyQuery = registerCapability({
  name: "ontology.query",
  domain: "ontology",
  description:
    "Typed multi-hop traversal from a start node over named relationship type(s) to a given depth. " +
    "Returns the reachable subgraph (nodes + edges), org + workspace scoped. Read-only; no Cypher required.",
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
    startNodeId: z.string().describe("publicId of the node to start the traversal from"),
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
      .describe("Maximum number of reachable nodes to return (1–500, default 100)"),
  }),
  output: z.object({
    startNode: traversedNode
      .nullable()
      .describe("The start node, or null if it does not exist in this org + workspace"),
    nodes: z
      .array(traversedNode)
      .describe("Reachable nodes including the start node (depth 0), deduplicated by nodeId"),
    edges: z.array(traversedEdge).describe("Edges traversed between the returned nodes"),
    truncated: z
      .boolean()
      .describe("True when the result was capped by `limit` and more nodes were reachable"),
  }),
});

export type OntologyQueryInput = z.output<typeof ontologyQuery.input>;
export type OntologyQueryOutput = z.output<typeof ontologyQuery.output>;
