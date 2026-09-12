import { z } from "zod";
import { defineTool } from "./_define";
import { agentRoleAssign } from "../agent.role.assign";
import { agentRoleRevoke } from "../agent.role.revoke";

/**
 * Appendix E: `set_agent_role` — absorbs `assign_agent_role` and
 * `revoke_agent_role`. Blank Does column: the two jobs are unchanged, and only
 * the verb moves into an argument (ADR-025), the same way `set_member_role`
 * takes removal as the role value `none`.
 *
 * The two sources agreed on every governed field — high sensitivity, approval
 * required, high risk, org Owner/Admin and workspace Owner — so there is
 * nothing to resolve and everything carries.
 *
 * What carries with them, and matters more than the schema, is enforced in the
 * handler and stated on the sources (§6.3, Agent RBAC §3.2/§3.4): only system
 * agent roles or custom roles may attach to an agent, never a human org role,
 * because the system org Owner role is a super-user via the resolver's own
 * override and attaching it to an unattended automation would be privilege
 * escalation by construction. Custom roles stay enterprise-only. And the
 * delegation ceiling holds — a user cannot attach a role whose grants exceed
 * their own effective grants (`agent_role_ceiling_exceeded`), which is §6.2's
 * rule that "an agent can never do more than the person it acts for."
 */
export const setAgentRole = defineTool({
  name: "set_agent_role",
  domain: "agent",
  description:
    "Attach or detach an IAM role on an agent's delegated principal. System agent roles (Agent Observer/Contributor/Operator) are assignable at every tier; custom roles are enterprise-only. Refused when the role's grants exceed the caller's own effective grants (delegation ceiling). Revocation is idempotent and soft-deletes the assignment so the audit trail survives. Audited with principal_kind='agent'.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["assign_agent_role", "revoke_agent_role"],
  // Every input and output field of both contracts is carried.
  drops: [],

  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  mutates: true,

  input: z.object({
    // Identical in both sources; carried from assign.
    agentId: agentRoleAssign.input.shape.agentId,
    // Carried from assign, whose `.describe()` names both the system-role and
    // custom-role forms the handler accepts.
    roleName: agentRoleAssign.input.shape.roleName,

    /** ADR-025: the verb the two v1 contracts encoded in their names. */
    action: z.enum(["assign", "revoke"]),
  }),

  output: z.object({
    agentId: agentRoleAssign.output.shape.agentId,
    roleName: agentRoleAssign.output.shape.roleName,

    /**
     * Carried from assign. Nullable because `revoke_agent_role` is idempotent:
     * a revoke of a role the agent never held resolves no assignment, and
     * inventing an id for it would make a no-op look like a change.
     */
    roleId: agentRoleAssign.output.shape.roleId.nullable(),

    // The three outcome flags both sources returned, carried as they were.
    // `assign` answers with the first two, `revoke` with the third; each is
    // false on the branch it does not describe.
    assigned: agentRoleAssign.output.shape.assigned,
    alreadyAssigned: agentRoleAssign.output.shape.alreadyAssigned,
    revoked: agentRoleRevoke.output.shape.revoked,
  }),
});

export type SetAgentRoleInput = z.output<typeof setAgentRole.input>;
export type SetAgentRoleOutput = z.output<typeof setAgentRole.output>;
