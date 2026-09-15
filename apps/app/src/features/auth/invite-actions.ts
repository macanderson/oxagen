"use server";
// Accept or decline an invitation. Both re-read the invitation (through the
// system lookups seam, which carries the org id the write needs) and the
// session, and re-run the decision the page made, so a crafted POST cannot
// accept an invitation addressed to someone else or one that has closed. The
// write is the `accept_member_invite` / `decline_member_invite` agent tool
// through the kernel seam's InviteeCtx overload.
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { kernelWrite } from "@/server/kernel";
import { getAuthUser } from "@/server/session";
import { systemLookups } from "@/server/tenancy-lookups";
import { requireInvitee } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { decideInvitation } from "./invitation";
import { isInvitationToken, toInvitationView } from "./invitations";

export type InviteActionResult =
  | { ok: true; to: SafePath }
  | {
      ok: false;
      reason: "not_found" | "closed" | "sign_in" | "wrong_account" | "failed";
    };

type Decision = "accept" | "decline";

async function decide(
  token: string,
  decision: Decision,
): Promise<InviteActionResult> {
  if (!isInvitationToken(token)) return { ok: false, reason: "not_found" };
  const [record, user] = await Promise.all([
    systemLookups.invitationByToken(token),
    getAuthUser(),
  ]);
  if (!record) return { ok: false, reason: "not_found" };
  const read = toInvitationView(token, record);
  if (!read.ok) return { ok: false, reason: "not_found" };
  const verdict = decideInvitation(read.value, user?.email ?? null);
  if (verdict.kind === "closed") return { ok: false, reason: "closed" };
  if (verdict.kind === "sign-in" || !user)
    return { ok: false, reason: "sign_in" };
  if (verdict.kind === "wrong-account")
    return { ok: false, reason: "wrong_account" };

  // The invitee is not a member yet, so the context names the invitation's
  // organization and the signed-in person it is addressed to; IAM and the
  // handler decide.
  const { ctx } = await requireInvitee(token);
  const input = { invitationPublicId: token };
  const result =
    decision === "accept"
      ? await kernelWrite(ctx, orgMemberInviteAccept, input)
      : await kernelWrite(ctx, orgMemberInviteDecline, input);
  if (!result.ok) return { ok: false, reason: "failed" };
  return decision === "accept"
    ? { ok: true, to: routes.people(read.value.orgSlug) }
    : { ok: true, to: routes.root() };
}

export async function acceptInvitation(
  token: string,
): Promise<InviteActionResult> {
  return decide(token, "accept");
}

export async function declineInvitation(
  token: string,
): Promise<InviteActionResult> {
  return decide(token, "decline");
}
