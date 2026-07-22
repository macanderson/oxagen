import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.revoke — revoke an agent's role assignment.
 *
 * Soft-deletes the iam.principal_role_assignments row for the agent's
 * principal. Note: per docs/specs/agent-rbac/spec.md §3.2, every agent must
 * always carry exactly one role — this is intended for use immediately
 * before/alongside agent.role.assign granting a replacement, or when an
 * agent is being archived. Revoking WITHOUT a replacement leaves the agent
 * with no grant to match, which resolves to defaultEffect (fail-closed for
 * most capabilities) rather than an "unassigned" special case.
 */
export const agentRoleRevoke = registerCapability({
  name: "revoke_agent_role",
  domain: "agent",
  description:
    "Revoke (soft-delete) an agent's role assignment. Emits the standard IAM audit event with principal_kind='agent'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "governance",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  audit: { targetKind: "agent", targetIdField: "agentId" },
  input: z.object({
    agentId: z.string().describe("Public agent id (agt_…), UUID, or slug"),
    roleId: z.string().describe("Public role id (rol_…) to revoke"),
  }),
  output: z.object({
    revoked: z.boolean(),
    agentId: z.string(),
    roleId: z.string(),
  }),
});

export type AgentRoleRevokeInput = z.output<typeof agentRoleRevoke.input>;
export type AgentRoleRevokeOutput = z.output<typeof agentRoleRevoke.output>;
