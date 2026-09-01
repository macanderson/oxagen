import { z } from "zod";
import { registerCapability } from "../registry";

export const graphNodeList = registerCapability({
  name: "list_nodes",
  domain: "graph",
  description:
    "Paginated browse of customer-context nodes in the workspace graph. Enables graph explorer UI.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    labels: z
      .array(z.string())
      .optional()
      .describe("Filter by node labels (e.g., Feature, Issue)"),
    sourceId: z.string().optional().describe("Filter by source connector ID"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(50)
      .describe("Max results (default 50)"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    query: z
      .string()
      .optional()
      .describe("Text search in displayName and description"),
  }),
  output: z.object({
    nodes: z.array(
      z.object({
        id: z.string().describe("Node ID (Neo4j UUID)"),
        labels: z.array(z.string()).describe("Node labels"),
        properties: z.record(z.unknown()).describe("Node properties"),
        displayName: z.string(),
        sourceId: z.string().optional(),
        createdAt: z.string().optional(),
      }),
    ),
    total: z.number().describe("Total number of nodes matching the filter"),
    hasMore: z.boolean().describe("Whether more nodes exist beyond this page"),
    limit: z.number(),
    offset: z.number(),
  }),
});

export type GraphNodeListInput = z.output<typeof graphNodeList.input>;
export type GraphNodeListOutput = z.output<typeof graphNodeList.output>;
