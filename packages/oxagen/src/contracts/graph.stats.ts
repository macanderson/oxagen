import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive schema (mirrors RenderDirective in stream-event-types) — lets
// the agent surface render the GraphStats boxes inline in chat.
const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

export const graphStats = registerCapability({
  name: "get_graph_stats",
  domain: "graph",
  description:
    "Customer-context workspace graph statistics: node count, edge count, inferred edge count, and breakdown by type.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
    includeByType: z
      .boolean()
      .default(false)
      .describe("Include breakdown by node label and edge type"),
    includeGrowth: z
      .boolean()
      .default(false)
      .describe(
        "Include node-creation time buckets (today/yesterday/this week/last week) and a 14-day daily series",
      ),
  }),
  output: z.object({
    nodeCount: z.number().describe("Total number of nodes in the graph"),
    edgeCount: z.number().describe("Total number of edges (all types)"),
    inferredEdgeCount: z
      .number()
      .describe("Number of edges created by inference"),
    sourceCount: z.number().describe("Number of unique source connectors"),
    nodesByLabel: z
      .record(z.number())
      .optional()
      .describe("Node count breakdown by label (if includeByType=true)"),
    edgesByType: z
      .record(z.number())
      .optional()
      .describe("Edge count breakdown by type (if includeByType=true)"),
    lastModifiedAt: z
      .string()
      .describe("ISO timestamp of last graph modification"),
    growth: z
      .object({
        nodesToday: z
          .number()
          .int()
          .nonnegative()
          .describe("Nodes created since the start of today (UTC)"),
        nodesYesterday: z
          .number()
          .int()
          .nonnegative()
          .describe("Nodes created during the prior UTC day"),
        nodesThisWeek: z
          .number()
          .int()
          .nonnegative()
          .describe("Nodes created in the last 7 days (rolling, incl today)"),
        nodesLastWeek: z
          .number()
          .int()
          .nonnegative()
          .describe("Nodes created in the 7 days before this week"),
        daily: z
          .array(
            z.object({
              day: z.string().describe("UTC calendar day, YYYY-MM-DD"),
              count: z.number().int().nonnegative(),
            }),
          )
          .describe(
            "Last 14 UTC days of node-creation counts, ascending, zero-filled",
          ),
      })
      .optional()
      .describe(
        "Node-creation time buckets (present only when includeGrowth=true)",
      ),
    render: renderDirectiveSchema
      .optional()
      .describe(
        "Render directive for displaying the stat boxes in the chat UI (app surface only)",
      ),
  }),
});

export type GraphStatsInput = z.output<typeof graphStats.input>;
export type GraphStatsOutput = z.output<typeof graphStats.output>;
