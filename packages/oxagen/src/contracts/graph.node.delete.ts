import { z } from "zod";
import { registerCapability } from "../registry";

export const graphNodeDelete = registerCapability({
  name: "delete_node",
  domain: "graph",
  description: "Delete a KnowledgeNode and all its relationships from the graph.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "graph" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    nodeId: z.string().describe("publicId of the KnowledgeNode to delete"),
  }),
  output: z.object({
    deleted: z.boolean().describe("True if the node was found and deleted; false if it did not exist"),
  }),
});

export type GraphNodeDeleteInput = z.output<typeof graphNodeDelete.input>;
export type GraphNodeDeleteOutput = z.output<typeof graphNodeDelete.output>;
