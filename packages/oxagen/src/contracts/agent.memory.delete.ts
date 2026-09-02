import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.memory.delete — remove an AgentMemory completely.
 *
 * Unlike the confidence decay pass (which lets low-salience memories sink below
 * the recall threshold while staying in the audit record), this is a hard
 * `DETACH DELETE`: the node and its REMEMBERS/ABOUT edges are gone. It is the
 * "remove completely" verb the user asked for, so it carries a destructive
 * agent posture (requiresApproval) and a higher risk level than write/update.
 */
export const agentMemoryDelete = registerCapability({
  name: "delete_memory",
  domain: "agent",
  description:
    "Permanently delete an AgentMemory node (and its edges) by id. Destructive — prefer agent.memory.update to lower salience when you only want it to stop surfacing.",
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
      .describe("The AgentMemory node id (not publicId) to delete"),
  }),
  output: z.object({
    deleted: z
      .boolean()
      .describe(
        "true when a memory matched and was deleted; false when none matched in this workspace",
      ),
    memoryId: z.string(),
  }),
});

export type AgentMemoryDeleteInput = z.output<typeof agentMemoryDelete.input>;
export type AgentMemoryDeleteOutput = z.output<typeof agentMemoryDelete.output>;
