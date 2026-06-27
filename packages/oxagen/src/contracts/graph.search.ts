import { z } from "zod";
import { registerCapability } from "../registry";

const KINDS = ["entity", "file", "symbol", "chunk", "memory", "execution", "document", "message", "asset"] as const;

export const graphSearch = registerCapability({
  name: "graph.search",
  domain: "graph",
  description:
    "Natural-language semantic (vector) search across the entire knowledge graph — customer entities, source code (files/symbols/chunks), agent memories, executions, documents and messages — ranked by embedding similarity. Distinct from graph.node.search, which is a lexical substring match.",
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
    query: z.string().min(1).max(1000).describe("Natural-language query to embed and search by vector similarity"),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1–50, default 10)"),
    kinds: z
      .array(z.enum(KINDS))
      .optional()
      .describe("Optional filter by node kind (entity, file, symbol, chunk, memory, execution, document, message, asset). `asset` = files the agent generated (markdown/docx/pdf/images/video)."),
    isSystem: z.boolean().optional().describe("Filter by is_system flag — true for product-owned nodes, false for customer nodes"),
    labels: z.array(z.string()).optional().describe("Optional domain-label filter (e.g. [\"Person\", \"SourceFile\"])"),
  }),
  output: z.object({
    results: z.array(
      z.object({
        nodeId: z.string(),
        label: z.string(),
        displayName: z.string(),
        kind: z.string(),
        snippet: z.string(),
        score: z.number(),
        isSystem: z.boolean(),
      }),
    ),
  }),
});

export type GraphSearchInput = z.output<typeof graphSearch.input>;
export type GraphSearchOutput = z.output<typeof graphSearch.output>;
