import { z } from "zod";
import { registerCapability } from "../registry";

export const agentPlanApprove = registerCapability({
  name: "approve_plan",
  domain: "agent",
  description:
    "Approve, deny, or amend a previously-proposed plan; approval releases the agent stream to execute the plan's side-effectful steps",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "planning" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
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

export type AgentPlanApproveInput = z.output<typeof agentPlanApprove.input>;
export type AgentPlanApproveOutput = z.output<typeof agentPlanApprove.output>;
