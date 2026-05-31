import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentPlanCreate = registerCapability({
  name: "agent.plan.create",
  domain: "agent",
  description: "Propose a structured plan and persist it as an execution_step of type 'plan'; awaits user approval before any side-effectful step runs",
  mode: "sync",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "planning" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    parentMessageId: z.string(),
    title: z.string().min(1).max(200),
    steps: z
      .array(
        z.object({
          id: z.string().min(1),
          summary: z.string().min(1),
          intent: z.string(),
          capability: z.string().nullable(),
          inputPreview: z.unknown().nullable(),
          dependsOn: z.array(z.string()).default([]),
        }),
      )
      .min(1),
    rationale: z.string().optional(),
  }),
  output: z.object({
    planId: z.string(),
    status: z.literal("pending_approval"),
  }),
});

export type AgentPlanCreateInput = z.output<typeof agentPlanCreate.input>;
export type AgentPlanCreateOutput = z.output<typeof agentPlanCreate.output>;
