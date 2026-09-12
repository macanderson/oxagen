import { z } from "zod";
import { defineTool } from "./_define";
import { orgMemberInviteAccept } from "../org.member_invite.accept";
import { orgMemberInviteDecline } from "../org.member_invite.decline";

/**
 * Appendix E: `respond_to_invite` — "accept or decline". Absorbs
 * `accept_member_invite` and `decline_member_invite`.
 *
 * The two v1 contracts had identical inputs and identical authorization; only
 * the verb differed, which under ADR-025 makes the verb an argument rather than
 * a name. Both outputs survive: the terminal status from decline, and the
 * membership row from accept, which exists only on one of the two branches and
 * is therefore nullable rather than optional — a caller that reads
 * `membership === null` learns the invitation was declined, where a missing key
 * would be indistinguishable from a handler that forgot to fill it in.
 */
export const respondToInvite = defineTool({
  name: "respond_to_invite",
  domain: "org",
  description:
    "Accept or decline a pending organization invitation. Accepting creates the membership row and provisions least-privilege IAM; declining frees the reserved seat.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["accept_member_invite", "decline_member_invite"],
  // Every field of both contracts is carried. `decline`'s
  // `status: z.literal("declined")` is carried as the two-state enum below,
  // which is a widening of one branch, not the loss of a field.
  drops: [],

  // Sources disagree only on sensitivity: accept is "medium" (it provisions IAM
  // and creates a principal-bearing membership), decline is "low". The stricter
  // wins. Everything else is identical in both.
  agent: { requiresApproval: false, riskLevel: "low", category: "organization" },
  sensitivity: "medium", // accept_member_invite
  /**
   * `allow`, carried from both sources, and the one capability in this group
   * where that is right: at response time the invitee has no principal yet, so
   * a default-deny would deny the only call that could ever create one. The
   * handler is the real gate — it matches the authenticated user against the
   * invitation's email.
   */
  defaultEffect: "allow",
  defaultRoles: {
    // Both sources also listed org "Member". It is not a `SystemOrgRole`
    // (Owner | Admin | Compliance | Billing), so the entry was unreachable and
    // is not reproduced; `defaultEffect: "allow"` already covers every role
    // that reaches rule 8, which is the path a member actually takes.
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  mutates: true,

  input: z.object({
    // Identical in both sources; carried from accept.
    invitationPublicId: orgMemberInviteAccept.input.shape.invitationPublicId,

    /** ADR-025: the verb the two v1 contracts encoded in their names. */
    response: z.enum(["accept", "decline"]),
  }),

  output: z.object({
    invitationPublicId: orgMemberInviteDecline.output.shape.invitationPublicId,
    /** The invitation's terminal state — the one thing both branches return. */
    status: z.enum(["accepted", "declined"]),

    /**
     * Present only on accept. Carried field-for-field from
     * `accept_member_invite`'s output; null on decline, where no membership was
     * created and no IAM was provisioned.
     */
    membership: z
      .object({
        orgUserId: orgMemberInviteAccept.output.shape.orgUserId,
        orgId: orgMemberInviteAccept.output.shape.orgId,
        role: orgMemberInviteAccept.output.shape.role,
        joinedAt: orgMemberInviteAccept.output.shape.joinedAt,
      })
      .nullable(),
  }),
});

export type RespondToInviteInput = z.output<typeof respondToInvite.input>;
export type RespondToInviteOutput = z.output<typeof respondToInvite.output>;
