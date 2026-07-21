import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryClassEnum, memoryKindSchema } from "./agent.memory.model";
import { knowledgeNodeRefSchema } from "./knowledge.node-ref";

/**
 * agent.memory.citations.stats — workspace-wide citation analytics across all
 * executions: which memories and graph nodes agents actually cite, how useful
 * those citations were (influence), and where rules get violated (compliance).
 *
 * Aggregates the Neo4j :Citation graph
 * ((:Execution)-[:CITED]->(:Citation)-[:OF]->(:AgentMemory|:GraphNode)) — the
 * cross-execution rollup that list_memory_citations (per-execution) cannot
 * answer. Backs the Knowledge → Citations dashboard.
 */
const citedMemoryStatSchema = z.object({
  memoryId: z.string(),
  publicId: z.string(),
  lesson: z.string(),
  memoryClass: memoryClassEnum,
  memoryKind: memoryKindSchema,
  citationCount: z.number().int().nonnegative(),
  decisiveCount: z.number().int().nonnegative(),
  contributingCount: z.number().int().nonnegative(),
  consideredCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  violationCount: z.number().int().nonnegative(),
});

export const agentMemoryCitationStats = registerCapability({
  name: "get_citation_stats",
  domain: "agent",
  description:
    "Workspace citation analytics: totals and influence/compliance breakdowns, daily citation series, most-cited and least-useful memories, most-cited graph nodes, and most-violated rules.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Window in days for the daily series and totals"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Max entries per top-N list"),
  }),
  output: z.object({
    totals: z.object({
      citations: z.number().int().nonnegative(),
      executions: z
        .number()
        .int()
        .nonnegative()
        .describe("Distinct executions that cited anything in the window"),
      memoriesCited: z.number().int().nonnegative(),
      nodesCited: z
        .number()
        .int()
        .nonnegative()
        .describe("Distinct non-memory graph nodes cited"),
    }),
    byInfluence: z
      .record(z.number())
      .describe(
        "Citation count per influence level (DECISIVE/CONTRIBUTING/CONSIDERED/IGNORED)",
      ),
    byCompliance: z
      .record(z.number())
      .describe(
        "Citation count per compliance outcome (COMPLIED/DISCRETION/VIOLATION/NA)",
      ),
    daily: z
      .array(
        z.object({
          date: z.string().describe("YYYY-MM-DD"),
          citations: z.number().int().nonnegative(),
          violations: z.number().int().nonnegative(),
        }),
      )
      .describe("Per-day citation and violation counts across the window"),
    topMemories: z
      .array(citedMemoryStatSchema)
      .describe("Most-cited memories in the window, with influence breakdown"),
    leastUsefulMemories: z
      .array(citedMemoryStatSchema)
      .describe(
        "Memories repeatedly recalled but never influential (no DECISIVE/CONTRIBUTING citations)",
      ),
    mostViolatedRules: z
      .array(citedMemoryStatSchema)
      .describe("RULE/FACT memories ranked by violation citations"),
    topNodes: z
      .array(
        z.object({
          node: knowledgeNodeRefSchema,
          citationCount: z.number().int().nonnegative(),
          decisiveCount: z.number().int().nonnegative(),
          ignoredCount: z.number().int().nonnegative(),
        }),
      )
      .describe(
        "Most-cited non-memory graph nodes, resolved to human-label refs",
      ),
  }),
});

export type AgentMemoryCitationStatsInput = z.output<
  typeof agentMemoryCitationStats.input
>;
export type AgentMemoryCitationStatsOutput = z.output<
  typeof agentMemoryCitationStats.output
>;
export type CitedMemoryStat = z.output<typeof citedMemoryStatSchema>;
