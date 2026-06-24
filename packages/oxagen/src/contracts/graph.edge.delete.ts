import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

export const graphEdgeDelete = registerCapability({
  name: "graph.edge.delete",
  domain: "graph",
  description: "Delete a specific typed relationship between two KnowledgeNodes.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "graph" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    fromNodeId: z.string().describe("publicId of the source KnowledgeNode"),
    toNodeId: z.string().describe("publicId of the target KnowledgeNode"),
    edgeType: z
      .string()
      .regex(RELATIONSHIP_TYPE_PATTERN)
      .describe("Relationship type to delete — must match [A-Z][A-Z0-9_]{0,62}"),
  }),
  output: z.object({
    deleted: z.boolean().describe("True if the relationship was found and deleted; false if it did not exist"),
  }),
});

export type GraphEdgeDeleteInput = z.output<typeof graphEdgeDelete.input>;
export type GraphEdgeDeleteOutput = z.output<typeof graphEdgeDelete.output>;
