import { z } from "zod";
import { registerCapability } from "../registry";
import { evidenceSourceKindEnum } from "./agent.memory.model";

/**
 * agent.memory.evidence.attach — attach a corroborating (or refuting) :Evidence
 * node to a memory and adjust its confidence (schema §5/§7b). Supporting
 * evidence pulls confidence up by strength (capped 100) and refreshes the decay
 * clock; refuting evidence pulls it down. This is how confidence recovers
 * between decay passes.
 */
export const agentMemoryEvidenceAttach = registerCapability({
  name: "agent.memory.evidence.attach",
  domain: "agent",
  description:
    "Attach supporting or refuting evidence to a memory, adjusting its confidence and refreshing the decay clock.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    memoryId: z.string().min(1),
    sourceKind: evidenceSourceKindEnum,
    strength: z
      .number()
      .min(0)
      .max(1)
      .describe("0-1 contribution; confidence moves by strength*100"),
    detail: z.string().max(1000).optional(),
    refutes: z
      .boolean()
      .default(false)
      .describe("true = negative evidence (REFUTES, lowers confidence)"),
  }),
  output: z.object({
    evidenceId: z.string(),
    confidenceScore: z.number(),
  }),
});

export type AgentMemoryEvidenceAttachInput = z.output<
  typeof agentMemoryEvidenceAttach.input
>;
export type AgentMemoryEvidenceAttachOutput = z.output<
  typeof agentMemoryEvidenceAttach.output
>;
