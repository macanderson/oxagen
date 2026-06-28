import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.memory.list — enumerate the AgentMemory nodes a workspace has
 * accumulated, newest first, with optional weight/kind/node filters.
 *
 * This is the non-semantic counterpart to `agent.memory.recall`: recall needs
 * a query string to vector-search, whereas the Knowledge → Memories surface
 * (and `oxagen memory list`) needs to browse everything that exists. Both read
 * the same Neo4j `:AgentMemory` nodes written by `agent.memory.write`, so every
 * surface sees an identical memory set with no store drift.
 */

/** Shared record shape — also the projection returned by `listMemories()`. */
export const agentMemoryRecordSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  nodeRef: z.string(),
  weight: z.enum(["low", "high", "critical"]),
  kind: z.string(),
  lesson: z.string(),
  source: z.string(),
  confidence: z.number(),
  createdAt: z.string(),
  lastReinforcedAt: z.string().nullable(),
});

export const agentMemoryList = registerCapability({
  name: "agent.memory.list",
  domain: "agent",
  description:
    "List the workspace's AgentMemory nodes (newest first) with optional weight/kind/node filters; non-semantic browse counterpart to agent.memory.recall",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    nodeRef: z
      .string()
      .optional()
      .describe("Scope to memories anchored on a single graph node ref"),
    minWeight: z
      .enum(["low", "high", "critical"])
      .optional()
      .describe("Only return memories at or above this weight"),
    kind: z
      .enum([
        "routine-change",
        "constraint",
        "bug-root-cause",
        "convention-deviation",
        "gotcha",
      ])
      .optional()
      .describe("Filter to a single memory kind"),
    limit: z.number().int().positive().max(200).default(100),
    offset: z.number().int().nonnegative().default(0),
  }),
  output: z.object({
    memories: z.array(agentMemoryRecordSchema),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe("Total matching memories for the tenant, ignoring limit/offset"),
  }),
});

export type AgentMemoryRecord = z.output<typeof agentMemoryRecordSchema>;
export type AgentMemoryListInput = z.output<typeof agentMemoryList.input>;
export type AgentMemoryListOutput = z.output<typeof agentMemoryList.output>;
