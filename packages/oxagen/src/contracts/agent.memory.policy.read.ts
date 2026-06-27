import { z } from "zod";
import { registerCapability } from "../registry";

export const memoryPolicySchema = z.object({
  halfLifeLowDays: z.number().int().positive().default(30),
  halfLifeHighDays: z.number().int().positive().default(90),
  recallThreshold: z.number().min(0).max(1).default(0.1),
});

export const agentMemoryPolicyRead = registerCapability({
  name: "agent.memory.policy.read",
  domain: "agent",
  description:
    "Read the workspace memory decay policy: half-lives by weight and recall confidence threshold",
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
  input: z.object({}),
  output: memoryPolicySchema,
});

export type AgentMemoryPolicyReadOutput = z.output<typeof agentMemoryPolicyRead.output>;
