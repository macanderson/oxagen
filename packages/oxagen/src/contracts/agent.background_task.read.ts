import { z } from "zod";
import { registerCapability } from "../registry";

export const agentTaskBackgroundRead = registerCapability({
  name: "get_background_task",
  domain: "agent",
  description: "Read the status, progress, and result of a background task",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "background" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    taskId: z.string(),
  }),
  output: z.object({
    taskId: z.string(),
    kind: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    label: z.string().nullable(),
    resultPayload: z.unknown().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
});

export type AgentTaskBackgroundReadInput = z.output<
  typeof agentTaskBackgroundRead.input
>;
export type AgentTaskBackgroundReadOutput = z.output<
  typeof agentTaskBackgroundRead.output
>;
