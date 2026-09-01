import { z } from "zod";
import { registerCapability } from "../registry";

// The plan row shape returned to callers. `tasks`/`goals`/`constraints` are the
// JSONB payloads stored by create/amend; tasks stay permissive (z.unknown) so a
// reader never rejects a plan an older/newer writer shaped slightly differently.
export const planViewSchema = z.object({
  planId: z.string(),
  status: z.string(),
  goals: z.array(z.string()),
  constraints: z.array(z.string()),
  tasks: z.array(z.unknown()),
  approvalRequired: z.boolean(),
  approvedAt: z.string().nullable(),
  approvedByUserId: z.string().nullable(),
  taskCount: z.number(),
  createdAt: z.string(),
});

export const agentPlanGet = registerCapability({
  name: "get_plan",
  domain: "agent",
  description:
    "Fetch a single execution plan by id, including its status, tasks, and approval state",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "planning" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    planId: z.string().describe("The plan's public id (apl_…)"),
  }),
  output: planViewSchema,
});

export type AgentPlanGetInput = z.output<typeof agentPlanGet.input>;
export type AgentPlanGetOutput = z.output<typeof agentPlanGet.output>;
