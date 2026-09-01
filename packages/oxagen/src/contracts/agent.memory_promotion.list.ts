import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryKindSchema } from "./agent.memory.model";

/**
 * agent.memory.promotion.candidates — the top OBSERVATIONs by citation pressure
 * that are ripe to promote to RULE/FACT (schema §7c). Backs the "promote me" UI
 * surface that always suggests the highest-signal 2-3 memories.
 */
export const agentMemoryPromotionCandidates = registerCapability({
  name: "list_memory_promotions",
  domain: "agent",
  description:
    "List the top OBSERVATION memories by citation pressure that are candidates for promotion to RULE/FACT.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    limit: z.number().int().positive().max(25).default(3),
  }),
  output: z.object({
    candidates: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        lesson: z.string(),
        memoryKind: memoryKindSchema,
        citationCount: z.number().int().nonnegative(),
        influenceCount: z.number().int().nonnegative(),
        confidenceScore: z.number(),
      }),
    ),
  }),
});

export type AgentMemoryPromotionCandidatesInput = z.output<
  typeof agentMemoryPromotionCandidates.input
>;
export type AgentMemoryPromotionCandidatesOutput = z.output<
  typeof agentMemoryPromotionCandidates.output
>;
