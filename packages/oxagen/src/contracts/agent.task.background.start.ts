import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentTaskBackgroundStart = registerCapability({
  name: "agent.task.background.start",
  domain: "agent",
  description: "Dispatch a long-running task as a durable Inngest job; the chat returns a task handle the user can monitor in the tray",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "background" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    kind: z.string(),
    payload: z.unknown(),
    label: z.string().optional(),
  }),
  output: z.object({
    taskId: z.string(),
    inngestRunId: z.string(),
  }),
});

export type AgentTaskBackgroundStartInput = z.output<typeof agentTaskBackgroundStart.input>;
export type AgentTaskBackgroundStartOutput = z.output<typeof agentTaskBackgroundStart.output>;
