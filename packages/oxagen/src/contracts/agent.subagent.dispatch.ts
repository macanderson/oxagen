import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSubagentDispatch = registerCapability({
  name: "dispatch_subagent",
  domain: "agent",
  description:
    "Fan out a set of tasks to multiple subagents running in parallel. Creates a dispatch fanout record and queues each task as an Inngest job. Returns a dispatchId the caller can poll via agent.subagent.aggregate. Budgets: max 100 tasks per dispatch, nesting depth 3, and 250 total descendant tasks per root fanout tree - a dispatch that would exceed the descendant cap is rejected; decompose less aggressively or return a summary instead.",
  mode: "async",
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
    parentMessageId: z
      .string()
      .describe("Message ID that triggered the fanout"),
    tasks: z
      .array(
        z.object({
          capabilityName: z
            .string()
            .describe("Capability to invoke for this subtask"),
          input: z.unknown().describe("Input payload for the capability"),
        }),
      )
      .min(1)
      .max(100),
    maxParallel: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe("Maximum number of tasks to run concurrently"),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Per-task timeout in seconds"),
  }),
  output: z.object({
    dispatchId: z
      .string()
      .describe("Fanout record ID — pass to agent.subagent.aggregate"),
    totalTasks: z.number(),
    status: z.enum(["pending", "running"]),
  }),
});

export type AgentSubagentDispatchInput = z.output<
  typeof agentSubagentDispatch.input
>;
export type AgentSubagentDispatchOutput = z.output<
  typeof agentSubagentDispatch.output
>;
