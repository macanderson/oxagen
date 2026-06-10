import { z } from "zod";
import { registerCapability } from "../registry";

export const graphCypher = registerCapability({
  name: "graph.cypher",
  domain: "graph",
  description:
    "Execute a Cypher query against the knowledge graph. " +
    "When nlQuery=true, natural language is translated to Cypher by an LLM (sandboxed to read-only). " +
    "Raw Cypher (nlQuery=false) is available to privileged roles only and supports both reads and writes.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "graph" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    query: z.string().min(1).max(10000).describe(
      "Either a Cypher query string (when nlQuery=false) or a natural-language description (when nlQuery=true)",
    ),
    nlQuery: z
      .boolean()
      .default(false)
      .describe(
        "When true, the query is treated as natural language and translated to Cypher by an LLM before execution. The LLM is instructed to produce read-only Cypher only.",
      ),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Optional named parameters to bind into the Cypher query"),
  }),
  output: z.object({
    rows: z.array(z.unknown()).describe("Result rows as plain objects"),
    columns: z.array(z.string()).describe("Column names in result order"),
    rowCount: z.number().describe("Number of rows returned"),
  }),
});

export type GraphCypherInput = z.output<typeof graphCypher.input>;
export type GraphCypherOutput = z.output<typeof graphCypher.output>;
