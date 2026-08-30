import { z } from "zod";
import { registerCapability } from "../registry";

// Decline a pending invitation. Frees the reserved seat by marking the
// invitation 'declined'. The invitee or an org admin can decline.
export const orgMemberInviteDecline = registerCapability({
  name: "decline_member_invite",
  domain: "org",
  description: "Decline a pending org invitation. Frees the reserved seat.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "organization",
  },
  sensitivity: "low",
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({
    invitationPublicId: z.string().min(1),
  }),
  output: z.object({
    invitationPublicId: z.string(),
    status: z.literal("declined"),
  }),
});

export type OrgMemberInviteDeclineInput = z.output<
  typeof orgMemberInviteDecline.input
>;
export type OrgMemberInviteDeclineOutput = z.output<
  typeof orgMemberInviteDecline.output
>;
