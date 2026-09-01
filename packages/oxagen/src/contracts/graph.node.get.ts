import { z } from "zod";
import { registerCapability } from "../registry";

export const graphNodeGet = registerCapability({
  name: "get_node",
  domain: "graph",
  description: "Retrieve a customer-context graph node by its publicId.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    nodeId: z.string().describe("publicId of the KnowledgeNode to retrieve"),
  }),
  output: z.object({
    node: z
      .object({
        nodeId: z.string(),
        label: z.string(),
        displayName: z.string(),
        description: z.string().nullable(),
        properties: z.record(z.string(), z.unknown()).nullable(),
        createdAt: z.string(),
        updatedAt: z.string().nullable(),
      })
      .nullable()
      .describe("The node, or null if not found"),
  }),
});

export type GraphNodeGetInput = z.output<typeof graphNodeGet.input>;
export type GraphNodeGetOutput = z.output<typeof graphNodeGet.output>;
