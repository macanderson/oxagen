import { z } from "zod";
import { registerCapability } from "../registry";

// Change a member's org role. Updates both the IAM principal_role_assignments
// and the legacy org_users.role column so both surfaces stay consistent.
//
// Authorization: org Owner or Admin only. Enforced in the handler via the
// principal_role_assignments table.
//
// Last-owner guard: demoting the last owner is blocked to prevent org lockout.
// Audited as org.role_changed.
export const orgMemberRoleChange = registerCapability({
  name: "change_member_role",
  domain: "org",
  description:
    "Change a member's org role. Replaces the existing org role assignment in the IAM layer and updates the legacy org_users.role column. Blocked if demoting the last org owner. Audited as org.role_changed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    // UUID of the user whose role should change.
    targetUserId: z
      .string()
      .min(1)
      .describe("The UUID of the user whose role to change"),
    // New org role name — must match a system role for this org
    // (e.g. 'Owner', 'Admin', 'Member', 'Billing', 'Compliance').
    newRole: z
      .string()
      .min(1)
      .describe("The new org role name (e.g. 'Admin', 'Member')"),
  }),
  output: z.object({
    changed: z.boolean(),
    targetUserId: z.string(),
    orgId: z.string(),
    previousRole: z.string().nullable(),
    newRole: z.string(),
  }),
});

export type OrgMemberRoleChangeInput = z.output<
  typeof orgMemberRoleChange.input
>;
export type OrgMemberRoleChangeOutput = z.output<
  typeof orgMemberRoleChange.output
>;
