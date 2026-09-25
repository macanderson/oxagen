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
 * - No tier gate (ADR-069): system agent roles AND custom roles are
 *   assignable at every org tier. The tier decides whether the kernel
 *   resolves a grant, which `list_iam_roles` reports as `enforcement`; it
 *   does not decide whether a role may exist or be held. A role bound below
 *   the enterprise tier governs nothing until the org moves to one, and the
 *   Roles page says so.
 * - Delegation ceiling: the assigning user cannot attach a role whose grants
 *   exceed the assigner's own effective grants — rejected with the stable
 *   error code `agent_role_ceiling_exceeded`.
 */
export const agentRoleAssign = registerCapability({
  name: "assign_agent_role",
  domain: "agent",
  description:
    "Assign an IAM role to an agent's delegated principal. System agent roles (Agent Observer/Contributor/Operator) and custom roles are both assignable at every tier; whether the kernel resolves the grant is what the tier decides, and list_iam_roles reports it. Rejected when the role's grants exceed the assigning user's own effective grants (delegation ceiling). Audited with principal_kind='agent'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
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
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Why the role is assigned. Kept in the audit event's recorded input, where an approver reads it.",
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
