import { z } from "zod";
import { registerCapability } from "../registry";
import {
  agentMemoryRecordSchema,
  memoryClassEnum,
  memoryKindSchema,
} from "./agent.memory.model";

/**
 * agent.memory.list — enumerate the AgentMemory nodes a workspace has
 * accumulated, newest first, with optional class/kind/enforcement/node filters.
 *
 * This is the non-semantic counterpart to `agent.memory.recall`: recall needs
 * a query string to vector-search, whereas the Knowledge → Memories surface
 * (and `oxagen memory list`) needs to browse everything that exists. Both read
 * the same Neo4j `:AgentMemory` nodes written by `agent.memory.write`, so every
 * surface sees an identical memory set with no store drift.
 */

// The canonical record shape lives in agent.memory.model; re-exported here so
// existing importers of `agentMemoryRecordSchema` from this module keep working.
export { agentMemoryRecordSchema };

export const agentMemoryList = registerCapability({
  name: "list_memories",
  domain: "agent",
  description:
    "List the workspace's AgentMemory nodes with optional weight/kind/node/citation filters and sort by recency or citation count; non-semantic browse counterpart to agent.memory.recall",
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
    memoryClass: memoryClassEnum
      .optional()
      .describe("Filter to a single epistemic class (OBSERVATION/RULE/FACT)"),
    memoryKind: memoryKindSchema
      .optional()
      .describe("Filter to a single memory kind (content domain)"),
    minEnforcement: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Only return rules at or above this enforcement score"),
    minCitations: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Only return memories cited at least this many times"),
    sort: z
      .enum(["createdAt", "citationCount"])
      .default("createdAt")
      .describe(
        "Ordering axis: createdAt (recency, the default) or citationCount (how often the memory has been cited)",
      ),
    sortDir: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe(
        "Sort direction; defaults to descending (newest / most-cited first)",
      ),
    limit: z.number().int().positive().max(200).default(100),
    offset: z.number().int().nonnegative().default(0),
  }),
  output: z.object({
    memories: z.array(agentMemoryRecordSchema),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Total matching memories for the tenant, ignoring limit/offset",
      ),
  }),
});

export type { AgentMemoryRecord } from "./agent.memory.model";
export type AgentMemoryListInput = z.output<typeof agentMemoryList.input>;
export type AgentMemoryListOutput = z.output<typeof agentMemoryList.output>;
