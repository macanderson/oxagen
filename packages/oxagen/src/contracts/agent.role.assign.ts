import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.assign — attach an IAM role to a deployed agent's delegated
 * principal (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
 *
 * Writes iam.principal_role_assignments for the agent's own principal
 * (agent.agents.principalId). Governance rules enforced in the handler:
 *
 * - Only the system agent roles ("Agent Observer", "Agent Contributor",
 *   "Agent Operator") or CUSTOM roles may be attached to an agent — human org
 *   roles (Owner, Admin, …) are never agent-assignable (the system org Owner
 *   role is a super-user via resolver rule 7.5; attaching it to an unattended
 *   automation would be privilege escalation by construction).
 * - Tier gate (§3.4): system agent roles are assignable at EVERY org tier;
 *   custom roles remain enterprise-only (same canAccessACL check as custom
 *   IAM ACL).
 * - Delegation ceiling: the assigning user cannot attach a role whose grants
 *   exceed the assigner's own effective grants — rejected with the stable
 *   error code `agent_role_ceiling_exceeded`.
 */
export const agentRoleAssign = registerCapability({
  name: "assign_agent_role",
  domain: "agent",
  description:
    "Assign an IAM role to an agent's delegated principal. System agent roles (Agent Observer/Contributor/Operator) are assignable at every tier; custom roles are enterprise-only. Rejected when the role's grants exceed the assigning user's own effective grants (delegation ceiling). Audited with principal_kind='agent'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs"],
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
    roleName: z
      .string()
      .min(1)
      .describe(
        "IAM role name to attach (e.g. 'Agent Contributor' or a custom role name)",
      ),
  }),
  output: z.object({
    assigned: z.boolean().describe("True when the role is now attached"),
    alreadyAssigned: z
      .boolean()
      .describe("True when the agent already held an active assignment"),
    agentId: z.string().describe("Agent public id (agt_…)"),
    roleId: z.string().describe("Public role id (rol_…)"),
    roleName: z.string(),
  }),
});

export type AgentRoleAssignInput = z.output<typeof agentRoleAssign.input>;
export type AgentRoleAssignOutput = z.output<typeof agentRoleAssign.output>;
