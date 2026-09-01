import { z } from "zod";
import { registerCapability } from "../registry";
import { agentRoleAssignmentRow } from "./agent.role.list";

/**
 * agent.role.get — inspect one role relative to an agent's delegated
 * principal (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
 *
 * Resolves the named role in the org, reports whether the agent's principal
 * currently holds it (active, non-expired assignment), and returns the role's
 * capability grant list so a reviewer can see exactly what attaching it
 * confers. Unknown role names are a typed error (`agent_role_not_found`).
 */
const roleGrantRow = z.object({
  capability: z.string().describe("Capability name the grant applies to"),
  effect: z.enum(["allow", "deny", "require_approval"]),
});

export const agentRoleGet = registerCapability({
  name: "get_agent_role",
  domain: "agent",
  description:
    "Get one IAM role's status relative to an agent: whether the agent's delegated principal holds it, the assignment provenance when held, and the role's capability grant list (what attaching it confers). Read-only governance introspection.",
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
  mutates: false,
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
    roleName: z.string().min(1).describe("IAM role name to inspect"),
  }),
  output: z.object({
    agentId: z.string().describe("Agent public id (agt_…)"),
    roleId: z.string().describe("Public role id (rol_…)"),
    roleName: z.string(),
    assigned: z
      .boolean()
      .describe("True when the agent's principal holds an active assignment"),
    assignment: agentRoleAssignmentRow
      .nullable()
      .describe("The active assignment when held, null otherwise"),
    grants: z
      .array(roleGrantRow)
      .describe("Capability grants the role carries"),
  }),
});

export type AgentRoleGetInput = z.output<typeof agentRoleGet.input>;
export type AgentRoleGetOutput = z.output<typeof agentRoleGet.output>;
