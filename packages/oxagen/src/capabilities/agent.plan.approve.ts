import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentPlanApprove = registerCapability({
  name: "agent.plan.approve",
  domain: "agent",
  description: "Approve, deny, or amend a previously-proposed plan; approval releases the agent stream to execute the plan's side-effectful steps",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "planning" },
  input: z.object({
    planId: z.string(),
    decision: z.enum(["approve", "deny", "amend"]),
    amendedSteps: z
      .array(
        z.object({
          id: z.string(),
          summary: z.string(),
          intent: z.string(),
          capability: z.string().nullable(),
          inputPreview: z.unknown().nullable(),
          dependsOn: z.array(z.string()).default([]),
        }),
      )
      .optional(),
    note: z.string().optional(),
  }),
  output: z.object({
    planId: z.string(),
    status: z.enum(["approved", "denied", "amended"]),
  }),
});

export type AgentPlanApproveInput = z.infer<typeof agentPlanApprove.input>;
export type AgentPlanApproveOutput = z.infer<typeof agentPlanApprove.output>;
