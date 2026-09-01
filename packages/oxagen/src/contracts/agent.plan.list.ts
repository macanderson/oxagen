import { z } from "zod";
import { registerCapability } from "../registry";

// Lightweight per-plan summary for the list surface (full tasks are fetched via
// get_plan). goals are included since they identify a plan at a glance.
export const planSummarySchema = z.object({
  planId: z.string(),
  status: z.string(),
  goals: z.array(z.string()),
  approvalRequired: z.boolean(),
  approvedAt: z.string().nullable(),
  taskCount: z.number(),
  createdAt: z.string(),
});

export const agentPlanList = registerCapability({
  name: "list_plans",
  domain: "agent",
  description:
    "List a workspace's execution plans, newest first, optionally filtered by status; cursor-paginated",
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
    status: z
      .string()
      .optional()
      .describe(
        "Filter to plans in this status (draft, awaiting_approval, approved, denied, amended)",
      ),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque cursor — pass the previous page's nextCursor (an ISO createdAt)",
      ),
  }),
  output: z.object({
    plans: z.array(planSummarySchema),
    nextCursor: z.string().nullable(),
  }),
});

export type AgentPlanListInput = z.output<typeof agentPlanList.input>;
export type AgentPlanListOutput = z.output<typeof agentPlanList.output>;
