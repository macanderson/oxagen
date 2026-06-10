import { z } from "zod";
import { registerCapability } from "../registry";

export const graphStats = registerCapability({
  name: "graph.stats",
  domain: "graph",
  description: "Workspace graph statistics: node count, edge count, inferred edge count, breakdown by type.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    includeByType: z
      .boolean()
      .default(false)
      .describe("Include breakdown by node label and edge type"),
  }),
  output: z.object({
    nodeCount: z.number().describe("Total number of nodes in the graph"),
    edgeCount: z.number().describe("Total number of edges (all types)"),
    inferredEdgeCount: z.number().describe("Number of edges created by inference"),
    sourceCount: z.number().describe("Number of unique source connectors"),
    nodesByLabel: z
      .record(z.number())
      .optional()
      .describe("Node count breakdown by label (if includeByType=true)"),
    edgesByType: z
      .record(z.number())
      .optional()
      .describe("Edge count breakdown by type (if includeByType=true)"),
    lastModifiedAt: z.string().describe("ISO timestamp of last graph modification"),
  }),
});

export type GraphStatsInput = z.output<typeof graphStats.input>;
export type GraphStatsOutput = z.output<typeof graphStats.output>;
