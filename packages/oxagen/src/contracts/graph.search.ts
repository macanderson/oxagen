import { z } from "zod";
import { registerCapability } from "../registry";

export const graphSearch = registerCapability({
  name: "search_graph",
  domain: "graph",
  description:
    "Natural-language semantic (vector) search across customer-context entities in the shared workspace graph, ranked by embedding similarity. Product-owned runtime data is read through its typed memory, execution, trace, and asset capabilities.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    query: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "Natural-language query to embed and search by vector similarity",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results (1–50, default 10)"),
    labels: z
      .array(z.string())
      .optional()
      .describe('Optional domain-label filter (e.g. ["Person", "Company"])'),
  }),
  output: z.object({
    results: z.array(
      z.object({
        nodeId: z.string(),
        label: z.string(),
        displayName: z.string(),
        kind: z.literal("entity"),
        snippet: z.string(),
        score: z.number(),
      }),
    ),
  }),
});

export type GraphSearchInput = z.output<typeof graphSearch.input>;
export type GraphSearchOutput = z.output<typeof graphSearch.output>;
