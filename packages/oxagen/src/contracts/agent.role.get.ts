import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.get — read a single agent role assignment by (agentId, roleId).
 * Returns null (not a 404 throw) when the agent holds no such assignment —
 * "does this agent have this role" is a legitimate negative answer, not an
 * error.
 */
export const agentRoleGet = registerCapability({
  name: "get_agent_role",
  domain: "agent",
  description:
    "Read one role assignment for an agent by (agentId, roleId). Returns null when the agent does not hold that role.",
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
    roleId: z.string().describe("Public role id (rol_…)"),
  }),
  output: z.object({
    agentId: z.string(),
    assignment: z
      .object({
        assignmentId: z.string(),
        roleId: z.string(),
        roleName: z.string(),
        isSystemDefault: z.boolean(),
        workspaceId: z.string().nullable(),
        assignedAt: z.string(),
        expiresAt: z.string().nullable(),
      })
      .nullable(),
  }),
});

export type AgentRoleGetInput = z.output<typeof agentRoleGet.input>;
export type AgentRoleGetOutput = z.output<typeof agentRoleGet.output>;
