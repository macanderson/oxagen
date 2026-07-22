import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.assign — assign an IAM role to an agent principal.
 *
 * Writes iam.principal_role_assignments for the agent's principal
 * (agents.principalId). Every agent already carries exactly one system role
 * from creation (Agent Contributor default, docs/specs/agent-rbac/spec.md
 * §3.2) — this contract lets a human REPLACE that assignment with another of
 * the three system roles, or (enterprise-only) a custom agent role.
 *
 * Delegation ceiling (spec §3.1/Phase1 acceptance): the assigning principal
 * cannot attach a role whose grants exceed their OWN effective grants — an
 * agent can never be handed more power than the human granting it. Rejected
 * with a typed, human-readable error rather than a partial write.
 *
 * Tier gating (spec §3.4): the three system agent roles (Agent Observer/
 * Contributor/Operator) are assignable at every org tier; CUSTOM agent roles
 * remain enterprise-only, reusing the same tier check as custom IAM roles.
 */
export const agentRoleAssign = registerCapability({
  name: "assign_agent_role",
  domain: "agent",
  description:
    "Assign an IAM role to an agent's principal, replacing any existing assignment. Rejects when the target role's grants exceed the assigning principal's own effective grants (delegation ceiling), or when a CUSTOM agent role is requested on a non-enterprise org.",
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
    roleId: z
      .string()
      .describe("Public role id (rol_…) to assign to the agent"),
    workspaceId: z
      .string()
      .optional()
      .describe("Scope the assignment to one workspace; omitted = org-wide"),
    expiresAt: z
      .string()
      .datetime()
      .optional()
      .describe("Optional ISO timestamp after which the assignment lapses"),
  }),
  output: z.object({
    assignmentId: z.string().describe("Public assignment id (pra_…)"),
    agentId: z.string(),
    roleId: z.string(),
    roleName: z.string(),
    previousRoleId: z
      .string()
      .nullable()
      .describe("The role id replaced by this assignment, if any"),
  }),
});

export type AgentRoleAssignInput = z.output<typeof agentRoleAssign.input>;
export type AgentRoleAssignOutput = z.output<typeof agentRoleAssign.output>;
