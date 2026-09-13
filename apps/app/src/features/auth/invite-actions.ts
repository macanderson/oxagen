"use server";
// Accept or decline an invitation. Both re-read the invitation and the session
// and re-run the decision the page made, so a crafted POST cannot accept an
// invitation addressed to someone else or one that has closed. The write is the
// `accept_member_invite` / `decline_member_invite` agent tool through the kernel.
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { isFixtureMode } from "@/server/fixture-session";
import { decideInvitation } from "./invitation";
import { loadInvitation } from "./invitations";
import { ORG_ONLY_WORKSPACE, invokeAsUser } from "./kernel";
import { getAuthUser } from "./session";

export type InviteActionResult =
  | { ok: true; to: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "closed"
        | "sign_in"
        | "wrong_account"
        | "fixture"
        | "failed";
    };

type Decision = "accept" | "decline";

async function decide(
  token: string,
  decision: Decision,
): Promise<InviteActionResult> {
  const [read, user] = await Promise.all([
    loadInvitation(token),
    getAuthUser(),
  ]);
  if (!read.ok) return { ok: false, reason: "not_found" };
  const verdict = decideInvitation(read.value, user?.email ?? null, new Date());
  if (verdict.kind === "closed") return { ok: false, reason: "closed" };
  if (verdict.kind === "sign-in" || !user)
    return { ok: false, reason: "sign_in" };
  if (verdict.kind === "wrong-account")
    return { ok: false, reason: "wrong_account" };

  // Fixture mode shows the flow but writes nothing: accepting lands on the fixture org.
  if (isFixtureMode()) {
    return decision === "accept"
      ? { ok: true, to: `/${read.value.orgSlug}` }
      : { ok: true, to: "/" };
  }

  try {
    const { withSystemDb } = await import("@oxagen/database");
    // tenancy: unscoped seam (resolve the invitation's org id before its scope can be entered)
    const orgId = await withSystemDb(async (tx) => {
      const row = await tx.query.invitations.findFirst({
        where: (inv, { eq }) => eq(inv.publicId, token),
        columns: { orgId: true },
      });
      return row?.orgId ?? null;
    });
    if (!orgId) return { ok: false, reason: "not_found" };
    const scope = { orgId, workspaceId: ORG_ONLY_WORKSPACE };
    const input = { invitationPublicId: token };
    if (decision === "accept")
      await invokeAsUser(orgMemberInviteAccept, input, scope, user.id);
    else await invokeAsUser(orgMemberInviteDecline, input, scope, user.id);
    return decision === "accept"
      ? { ok: true, to: `/${read.value.orgSlug}` }
      : { ok: true, to: "/" };
  } catch (err) {
    const { logger } = await import("@oxagen/handlers/logger");
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), decision },
      "[invite] decision failed",
    );
    return { ok: false, reason: "failed" };
  }
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
