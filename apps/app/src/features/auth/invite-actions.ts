"use server";
// Accept or decline an invitation. requireInvitee resolves the signed-in person
// the invitation is addressed to (signed out → /login; an unknown token or
// another address → notFound), and the write is `accept_member_invite` /
// `decline_member_invite` through the kernel seam's InviteeCtx overload.
// Whether the invitation is still open is the handler's decision: a closed or
// expired one is a `conflict`, another account a `denied`.
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite } from "@/server/kernel";
import { requireInvitee, requireUser } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";

/**
 * Where an accepted invitation lands: Fleet of the first workspace of that
 * organization the person belongs to, as the design does. `list_workspaces`
 * returns every workspace of the organization with `role` null where the
 * person holds no membership, and such a workspace is a 404 (INV-15), so it
 * is skipped. The invitation names no workspace yet (#3886), so a person who
 * joined only the organization belongs to none of its workspaces and lands on
 * its People page, and so does one whose list cannot be read: the acceptance
 * already went through, and a failed read must not make it look refused.
 */
async function landingAfterAccept(orgSlug: string): Promise<SafePath> {
  const user = await requireUser();
  const read = await kernelRead(user, {
    contract: workspaceList,
    input: { orgSlug },
    page: "shell",
  });
  const ws = read.ok
    ? read.value.workspaces.find((w) => w.role !== null)
    : undefined;
  return ws === undefined
    ? routes.people(orgSlug)
    : routes.fleet(orgSlug, ws.slug);
}

export async function acceptInvitation(
  token: string,
): Promise<ActionResult<{ to: SafePath }>> {
  const { ctx, invitation } = await requireInvitee(token);
  const result = await kernelWrite(ctx, orgMemberInviteAccept, {
    invitationPublicId: token,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { to: await landingAfterAccept(invitation.orgSlug) },
  };
}

export async function declineInvitation(
  token: string,
): Promise<ActionResult<ContractOutput<typeof orgMemberInviteDecline>>> {
  const { ctx } = await requireInvitee(token);
  return kernelWrite(ctx, orgMemberInviteDecline, {
    invitationPublicId: token,
  });
}
