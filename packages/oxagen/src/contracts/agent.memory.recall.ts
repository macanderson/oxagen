import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryClassEnum } from "./agent.memory.model";

export const agentMemoryRecall = registerCapability({
  name: "agent.memory.recall",
  domain: "agent",
  description:
    "Query Neo4j AgentMemory by semantic similarity with optional class/enforcement filters; returns ranked memories scoped to the workspace",
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
    query: z.string().min(1),
    memoryClass: memoryClassEnum
      .optional()
      .describe("Only recall memories of this epistemic class"),
    minEnforcement: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Only recall rules at or above this enforcement score"),
    limit: z.number().int().positive().max(50).default(10),
    nodeRef: z.string().optional(),
  }),
  output: z.object({
    memories: z.array(
      z.object({
        id: z.string(),
        nodeRef: z.string(),
        memoryClass: memoryClassEnum,
        memoryKind: z.string(),
        lesson: z.string(),
        source: z.string(),
        confidenceScore: z.number(),
        enforcementScore: z.number().int().nullable(),
        score: z.number(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export type AgentMemoryRecallInput = z.output<typeof agentMemoryRecall.input>;
export type AgentMemoryRecallOutput = z.output<typeof agentMemoryRecall.output>;
