import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryPolicySchema } from "./agent.memory_policy.read";

export const agentMemoryPolicyWrite = registerCapability({
  name: "update_memory_policy",
  domain: "agent",
  description:
    "Update the workspace memory decay policy: half-lives by weight and recall confidence threshold",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: memoryPolicySchema.partial(),
  output: memoryPolicySchema,
});

export type AgentMemoryPolicyWriteInput = z.output<
  typeof agentMemoryPolicyWrite.input
>;
export type AgentMemoryPolicyWriteOutput = z.output<
  typeof agentMemoryPolicyWrite.output
>;
