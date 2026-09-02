import { z } from "zod";
import { registerCapability } from "../registry";

// Accept a pending invitation. Transitions the invitation to 'accepted',
// creates the org_users row, and provisions least-privilege IAM for the user.
export const orgMemberInviteAccept = registerCapability({
  name: "accept_member_invite",
  domain: "org",
  description:
    "Accept a pending org invitation. Creates the membership row and provisions least-privilege IAM.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "organization",
  },
  sensitivity: "medium",
  // The invitee (authenticated as themselves) can accept their own invite.
  // defaultEffect allow on Member covers the case after they're provisioned;
  // but at accept-time they have no principal yet — the handler trusts that
  // the authenticated userId matches the invitation email (validated in handler).
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({
    invitationPublicId: z.string().min(1),
  }),
  output: z.object({
    orgUserId: z.string(),
    orgId: z.string(),
    role: z.string(),
    joinedAt: z.string(),
  }),
});

export type OrgMemberInviteAcceptInput = z.output<
  typeof orgMemberInviteAccept.input
>;
export type OrgMemberInviteAcceptOutput = z.output<
  typeof orgMemberInviteAccept.output
>;
