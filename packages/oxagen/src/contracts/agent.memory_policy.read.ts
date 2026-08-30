import { z } from "zod";
import { registerCapability } from "../registry";

export const memoryPolicySchema = z.object({
  halfLifeLowDays: z
    .number()
    .int()
    .positive()
    .default(30)
    .describe("Decay half-life (days) for OBSERVATION memories"),
  halfLifeHighDays: z
    .number()
    .int()
    .positive()
    .default(90)
    .describe("Decay half-life (days) for RULE memories"),
  recallThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe(
      "Memories below this confidence fraction (0–1) are excluded from recall",
    ),
  complianceThreshold: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(70)
    .describe(
      "Enforcement at or above which a rule deviation counts as a VIOLATION (else DISCRETION)",
    ),
  defaultDecayFloor: z
    .number()
    .min(0)
    .max(100)
    .default(5)
    .describe("Confidence never auto-decays below this floor"),
});

export const agentMemoryPolicyRead = registerCapability({
  name: "get_memory_policy",
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

export type AgentMemoryPolicyReadOutput = z.output<
  typeof agentMemoryPolicyRead.output
>;
