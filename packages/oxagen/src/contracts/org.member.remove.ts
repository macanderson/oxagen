import { z } from "zod";
import { registerCapability } from "../registry";

// Permanently remove a member from an org. The target member's org_users row
// is deleted, their principal_role_assignments revoked, and their principal
// soft-deleted. The action is irreversible; a new invitation is required to
// re-onboard. Audited as org.member_removed.
//
// Authorization: org Owner or Admin only. Enforced in the handler via the
// principal_role_assignments table (not the legacy org_users.role string) so
// the gate mirrors the billing authz pattern.
//
// Last-owner guard: removing the final owner is blocked to prevent org lockout.
export const orgMemberRemove = registerCapability({
  name: "remove_org_member",
  domain: "org",
  description:
    "Remove a member from the org. Revokes their role assignments and deactivates their principal. Blocked if the target is the last org owner. Audited as org.member_removed.",
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
    // publicId of the org_users row (oru_ prefix) OR the target userId (uuid).
    // The handler resolves either form against ctx.orgId for IDOR safety.
    targetUserId: z
      .string()
      .min(1)
      .describe("The UUID of the user to remove from the org"),
  }),
  output: z.object({
    removed: z.boolean(),
    targetUserId: z.string(),
    orgId: z.string(),
  }),
});

export type OrgMemberRemoveInput = z.output<typeof orgMemberRemove.input>;
export type OrgMemberRemoveOutput = z.output<typeof orgMemberRemove.output>;
