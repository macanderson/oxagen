import { z } from "zod";
import { registerCapability } from "../registry";

const agentRoleAssignmentRow = z.object({
  assignmentId: z.string().describe("Public assignment id (pra_…)"),
  roleId: z.string(),
  roleName: z.string(),
  isSystemDefault: z.boolean(),
  workspaceId: z.string().nullable(),
  assignedAt: z.string().describe("ISO timestamp"),
  expiresAt: z.string().nullable(),
});

/**
 * agent.role.list — list an agent's active (non-revoked, non-expired) role
 * assignments. Read-only counterpart to agent.role.assign/.revoke.
 */
export const agentRoleList = registerCapability({
  name: "list_agent_roles",
  domain: "agent",
  description:
    "List an agent's active role assignments (non-revoked, non-expired) — the human-readable face of 'what can this agent do'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Public agent id (agt_…), UUID, or slug"),
  }),
  output: z.object({
    agentId: z.string(),
    assignments: z.array(agentRoleAssignmentRow),
  }),
});

export type AgentRoleListInput = z.output<typeof agentRoleList.input>;
export type AgentRoleListOutput = z.output<typeof agentRoleList.output>;
export type AgentRoleAssignmentRow = z.output<typeof agentRoleAssignmentRow>;
