import { z } from "zod";
import { registerCapability } from "../registry";

export const agentTaskBackgroundCancel = registerCapability({
  name: "cancel_background_task",
  domain: "agent",
  description:
    "Cancel a running background task; downstream Inngest steps stop on next checkpoint",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "background",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    taskId: z.string(),
    reason: z.string().optional(),
  }),
  output: z.object({
    taskId: z.string(),
    status: z.enum(["cancelled", "already_completed", "already_cancelled"]),
  }),
});

export type AgentTaskBackgroundCancelInput = z.output<
  typeof agentTaskBackgroundCancel.input
>;
export type AgentTaskBackgroundCancelOutput = z.output<
  typeof agentTaskBackgroundCancel.output
>;
