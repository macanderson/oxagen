"use server";
// Accept or decline an invitation. requireInvitee resolves the signed-in person
// the invitation is addressed to (signed out → /login; an unknown token or
// another address → notFound), and the write is `accept_member_invite` /
// `decline_member_invite` through the kernel seam's InviteeCtx overload.
// Whether the invitation is still open is the handler's decision: a closed or
// expired one is a `conflict`, another account a `denied`.
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireInvitee } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";

/** An accepted invitation continues to the organization's People page. */
export async function acceptInvitation(
  token: string,
): Promise<ActionResult<{ to: SafePath }>> {
  const { ctx, invitation } = await requireInvitee(token);
  const result = await kernelWrite(ctx, orgMemberInviteAccept, {
    invitationPublicId: token,
  });
  return result.ok
    ? { ok: true, value: { to: routes.people(invitation.orgSlug) } }
    : result;
}

export async function declineInvitation(
  token: string,
): Promise<ActionResult<ContractOutput<typeof orgMemberInviteDecline>>> {
  const { ctx } = await requireInvitee(token);
  return kernelWrite(ctx, orgMemberInviteDecline, {
    invitationPublicId: token,
  });
}
