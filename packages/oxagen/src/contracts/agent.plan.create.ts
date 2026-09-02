import { z } from "zod";
import { registerCapability } from "../registry";

const planTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  parentTaskId: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).default([]),
  capability: z.string().nullable().optional(),
  estimatedDurationMs: z.number().optional(),
});

export const agentPlanCreate = registerCapability({
  name: "create_plan",
  domain: "agent",
  description:
    "Create a structured hierarchical execution plan with tasks, dependencies, and approval gates; the plan must be approved via agent.plan.approve before execution proceeds",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "planning" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    goals: z
      .array(z.string())
      .min(1)
      .max(20)
      .describe("High-level goals this plan achieves"),
    constraints: z
      .array(z.string())
      .default([])
      .describe("Hard constraints the plan must respect"),
    tasks: z.array(planTaskSchema).min(1).max(100),
    approvalRequired: z
      .boolean()
      .default(true)
      .describe("Whether user approval is required before execution"),
    messageId: z
      .string()
      .optional()
      .describe("Originating conversation message ID"),
  }),
  output: z.object({
    planId: z.string(),
    status: z.enum(["draft", "awaiting_approval"]),
    goals: z.array(z.string()),
    tasks: z.array(planTaskSchema),
    approvalRequired: z.boolean(),
    createdAt: z.string(),
  }),
});

export type AgentPlanCreateInput = z.output<typeof agentPlanCreate.input>;
export type AgentPlanCreateOutput = z.output<typeof agentPlanCreate.output>;
