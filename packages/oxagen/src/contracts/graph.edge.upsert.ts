import { z } from "zod";
import { registerCapability } from "../registry";

export const GRAPH_EDGE_TYPES = [
  "RELATED_TO",
  "PART_OF",
  "CAUSED_BY",
  "REFERENCES",
  "SIMILAR_TO",
  "DEPENDS_ON",
  "CREATED_BY",
  "MENTIONS",
] as const;

export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

export const graphEdgeUpsert = registerCapability({
  name: "graph.edge.upsert",
  domain: "graph",
  description: "MERGE a typed relationship between two KnowledgeNodes. Edge type must be one of the allowed relationship types.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    fromNodeId: z.string().describe("publicId of the source KnowledgeNode"),
    toNodeId: z.string().describe("publicId of the target KnowledgeNode"),
    edgeType: z.enum(GRAPH_EDGE_TYPES).describe("Relationship type between the two nodes"),
    properties: z.record(z.string(), z.string()).optional().describe("Optional string key-value metadata to store on the relationship"),
  }),
  output: z.object({
    edgeId: z.string().describe("Composite identifier: fromNodeId:edgeType:toNodeId"),
    created: z.boolean().describe("True if the edge was newly created, false if it already existed"),
  }),
});

export type GraphEdgeUpsertInput = z.output<typeof graphEdgeUpsert.input>;
export type GraphEdgeUpsertOutput = z.output<typeof graphEdgeUpsert.output>;
