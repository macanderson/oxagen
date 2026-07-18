import { z } from "zod";
import { registerCapability } from "../registry";
import { agentMemoryRecordSchema } from "./agent.memory.list";

/**
 * agent.memory.promote — move a memory up the confidence ladder
 * (OBSERVATION → RULE → FACT), recording an auditable :Promotion event.
 *
 * Promotion is the only way class changes: it sets enforcement (policy) and, for
 * FACT, requires human confirmation. The handler enforces the invariants
 * (FACT ⟹ confirmed by USER + enforcement 100; RULE ⟹ enforcement 1-100).
 */
export const agentMemoryPromote = registerCapability({
  name: "promote_memory",
  domain: "agent",
  description:
    "Promote a memory to RULE or FACT, recording an auditable promotion event. FACT requires human confirmation and forces enforcement 100.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    memoryId: z
      .string()
      .min(1)
      .describe("The AgentMemory node id (not publicId) to promote"),
    toClass: z
      .enum(["RULE", "FACT"])
      .describe("Target class; OBSERVATION cannot be a promotion target"),
    enforcementScore: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Enforcement (1-100) to set for a RULE; ignored for FACT (forced 100)",
      ),
    rationale: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Optional: why this memory is being promoted"),
    basedOnEvidenceIds: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        "Evidence node ids supporting the promotion — creates :BASED_ON edges",
      ),
  }),
  output: agentMemoryRecordSchema,
});

export type AgentMemoryPromoteInput = z.output<typeof agentMemoryPromote.input>;
export type AgentMemoryPromoteOutput = z.output<
  typeof agentMemoryPromote.output
>;
