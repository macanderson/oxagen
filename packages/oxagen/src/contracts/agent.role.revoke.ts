import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.revoke — detach an IAM role from an agent's delegated principal
 * (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
 *
 * Soft-deletes the matching iam.principal_role_assignments row so the audit
 * trail keeps the historical assignment. Idempotent: revoking a role the
 * agent does not hold returns `revoked: false` rather than erroring.
 */
export const agentRoleRevoke = registerCapability({
  name: "revoke_agent_role",
  domain: "agent",
  description:
    "Revoke an IAM role from an agent's delegated principal — soft-deletes the principal_role_assignments row (audit trail preserved). Idempotent: returns revoked=false when the agent did not hold the role. Audited with principal_kind='agent'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    agentId: z
      .string()
      .min(1)
      .describe("Agent public id (agt_…), UUID, or slug — workspace-scoped"),
    roleName: z.string().min(1).describe("IAM role name to detach"),
  }),
  output: z.object({
    revoked: z
      .boolean()
      .describe(
        "True when an active assignment was revoked; false when none existed",
      ),
    agentId: z.string().describe("Agent public id (agt_…)"),
    roleName: z.string(),
  }),
});

export type AgentRoleRevokeInput = z.output<typeof agentRoleRevoke.input>;
export type AgentRoleRevokeOutput = z.output<typeof agentRoleRevoke.output>;
