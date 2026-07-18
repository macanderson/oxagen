import { z } from "zod";
import { registerCapability } from "../registry";
import { agentMemoryRecordSchema } from "./agent.memory.list";

/**
 * agent.memory.demote — move a memory down the confidence ladder
 * (FACT → RULE → OBSERVATION), recording an auditable :Demotion event.
 *
 * The inverse of promote_memory. The handler enforces direction (target class
 * must be strictly below the current class) and the class invariants on the way
 * down: OBSERVATION ⟹ enforcement null; RULE ⟹ enforcement 1-100 (provided or
 * defaulted); leaving FACT clears the human-confirmation fields.
 */
export const agentMemoryDemote = registerCapability({
  name: "demote_memory",
  domain: "agent",
  description:
    "Demote a memory to RULE or OBSERVATION, recording an auditable demotion event. Leaving FACT clears human confirmation; demoting to OBSERVATION clears enforcement.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      .describe("The AgentMemory node id (not publicId) to demote"),
    toClass: z
      .enum(["RULE", "OBSERVATION"])
      .describe(
        "Target class; must be strictly below the memory's current class (FACT cannot be a demotion target)",
      ),
    enforcementScore: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Enforcement (1-100) to set when demoting to RULE; ignored for OBSERVATION (forced null)",
      ),
    rationale: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Optional: why this memory is being demoted"),
  }),
  output: agentMemoryRecordSchema,
});

export type AgentMemoryDemoteInput = z.output<typeof agentMemoryDemote.input>;
export type AgentMemoryDemoteOutput = z.output<typeof agentMemoryDemote.output>;
