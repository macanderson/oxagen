import { z } from "zod";
import { registerCapability } from "../registry";

/** Shared schema for a single inferred semantic edge record. */
export const semanticEdgeSchema = z.object({
  id: z.string().describe("Unique edge identifier"),
  sourceNodeId: z.string().describe("publicId of the source KnowledgeNode"),
  targetNodeId: z.string().describe("publicId of the target KnowledgeNode"),
  type: z.string().describe("Relationship type as inferred by the LLM (customer-defined, not an enum)"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Inference confidence score 0.0–1.0"),
  source: z.object({
    connectorId: z.string().describe("Connector that owns the source node"),
    sourceId: z.string().describe("Connector-internal source identifier"),
  }),
  inferredAt: z.string().describe("ISO-8601 timestamp when the edge was inferred"),
  approved: z.boolean().optional().describe("Whether the edge has been approved by a workspace member"),
  approvedAt: z.string().nullable().optional().describe("ISO-8601 timestamp of approval, null if not yet approved"),
  approvedBy: z.string().nullable().optional().describe("User ID who approved the edge, null if not yet approved"),
});

export const semanticEdgeList = registerCapability({
  name: "semantic.edge.list",
  domain: "semantic",
  description:
    "Paginated browse of inferred semantic edges for a workspace. Supports filtering by relationship type, connector source, and confidence band.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    type: z.string().optional().describe("Filter to edges of this relationship type"),
    sourceId: z.string().optional().describe("Filter to edges whose source node originates from this connector sourceId"),
    confidenceMin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Return only edges with confidence >= this value"),
    confidenceMax: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Return only edges with confidence <= this value"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(50)
      .describe("Maximum results per page (1–250, default 50)"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Zero-based page offset"),
  }),
  output: z.object({
    edges: z.array(semanticEdgeSchema),
    total: z.number().describe("Total edges matching the filter (before pagination)"),
    limit: z.number(),
    offset: z.number(),
  }),
});

export type SemanticEdgeListInput = z.output<typeof semanticEdgeList.input>;
export type SemanticEdgeListOutput = z.output<typeof semanticEdgeList.output>;
export type SemanticEdge = z.output<typeof semanticEdgeSchema>;
