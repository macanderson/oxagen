import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.role.list — read the IAM roles attached to an agent's delegated
 * principal (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
 *
 * Read-only governance introspection: which roles this agent's principal
 * holds via iam.principal_role_assignments (active, non-expired only).
 */
export const agentRoleAssignmentRow = z.object({
  assignmentId: z.string().describe("Public assignment id (pra_…)"),
  roleId: z.string().describe("Public role id (rol_…)"),
  roleName: z.string(),
  scopeKind: z.enum(["org", "workspace"]),
  isSystemDefault: z
    .boolean()
    .describe(
      "True for system-seeded agent roles (Agent Observer/Contributor/Operator)",
    ),
  assignedAt: z.string().describe("ISO-8601 timestamp of the assignment"),
  assignedBy: z
    .string()
    .nullable()
    .describe(
      "User UUID that performed the assignment (null for system provisioning)",
    ),
  expiresAt: z
    .string()
    .nullable()
    .describe("ISO-8601 expiry for time-bounded assignments, null = permanent"),
  workspaceId: z
    .string()
    .nullable()
    .describe("Workspace the assignment is scoped to, null = org-wide"),
});

export const agentRoleList = registerCapability({
  name: "list_agent_roles",
  domain: "agent",
  description:
    "List the IAM roles attached to an agent's delegated principal — active, non-expired principal_role_assignments with role identity, scope, and assignment provenance. Read-only governance introspection.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Governance-posture reads must never be blocked by a zero credit balance.
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
    agentId: z
      .string()
      .min(1)
      .describe("Agent public id (agt_…), UUID, or slug — workspace-scoped"),
  }),
  output: z.object({
    agentId: z.string().describe("Agent public id (agt_…)"),
    roles: z
      .array(agentRoleAssignmentRow)
      .describe("Active role assignments, most recent first"),
    total: z.number().int(),
  }),
});

export type AgentRoleListInput = z.output<typeof agentRoleList.input>;
export type AgentRoleListOutput = z.output<typeof agentRoleList.output>;
export type AgentRoleAssignmentRow = z.output<typeof agentRoleAssignmentRow>;
