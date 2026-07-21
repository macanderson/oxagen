import { z } from "zod";
import { registerCapability } from "../registry";

export const graphNodeSearch = registerCapability({
  name: "search_nodes",
  domain: "graph",
  description:
    "Fuzzy search customer-context graph nodes by displayName and description, optionally filtered by label.",
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
    query: z
      .string()
      .min(1)
      .max(500)
      .describe("Text to search for in displayName or description"),
    labels: z
      .array(z.string())
      .optional()
      .describe("Restrict to nodes with one of these labels"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results to return (1–50, default 10)"),
  }),
  output: z.object({
    nodes: z.array(
      z.object({
        nodeId: z.string(),
        label: z.string(),
        displayName: z.string(),
        description: z.string().nullable(),
        score: z
          .number()
          .describe(
            "Relevance score — 1.0 when displayName matches, 0.5 when only description matches",
          ),
      }),
    ),
  }),
});

export type GraphNodeSearchInput = z.output<typeof graphNodeSearch.input>;
export type GraphNodeSearchOutput = z.output<typeof graphNodeSearch.output>;
