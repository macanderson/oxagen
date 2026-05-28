import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentTaskBackgroundCancel = registerCapability({
  name: "agent.task.background.cancel",
  domain: "agent",
  description: "Cancel a running background task; downstream Inngest steps stop on next checkpoint",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "background" },
  input: z.object({
    taskId: z.string(),
    reason: z.string().optional(),
  }),
  output: z.object({
    taskId: z.string(),
    status: z.enum(["cancelled", "already_completed", "already_cancelled"]),
  }),
});

export type AgentTaskBackgroundCancelInput = z.infer<typeof agentTaskBackgroundCancel.input>;
export type AgentTaskBackgroundCancelOutput = z.infer<typeof agentTaskBackgroundCancel.output>;
