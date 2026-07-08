import { z } from "zod";
import { registerCapability } from "../registry";
import { semanticEdgeSchema } from "./semantic.edge.list";

/** Re-export as canonical name — prefer semanticRelationshipSchema going forward */
export { semanticEdgeSchema as semanticRelationshipSchema } from "./semantic.edge.list";

export const semanticRelationshipList = registerCapability({
  name: "list_semantic_relationships",
  domain: "semantic",
  description:
    "Paginated browse of inferred semantic relationships for a workspace. Supports filtering by relationship type, connector source, and confidence band.",
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
    type: z.string().optional().describe("Filter to relationships of this type"),
    sourceId: z.string().optional().describe("Filter to relationships whose source node originates from this connector sourceId"),
    confidenceMin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Return only relationships with confidence >= this value"),
    confidenceMax: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Return only relationships with confidence <= this value"),
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
    total: z.number().describe("Total relationships matching the filter (before pagination)"),
    limit: z.number(),
    offset: z.number(),
  }),
});

export type SemanticRelationshipListInput = z.output<typeof semanticRelationshipList.input>;
export type SemanticRelationshipListOutput = z.output<typeof semanticRelationshipList.output>;
