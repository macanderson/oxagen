// Read one invitation by its public token for /invite/[token].
//
// Live: `org.invitations` by public id, with the organization and the inviter's
// display name, through withSystemDb. Deliberate: the visitor is not yet a
// member of the invitation's org (often not signed in at all), so no tenant
// scope can be entered; the token is the capability, and the page shows only
// what the invitation email already disclosed.
import "server-only";
import { type Read, readError, readOk } from "@/data/not-backed";
import { isFixtureMode } from "@/server/fixture-session";
import { fixtureInvitation } from "./fixture";
import { InvitationView, toOrgRole } from "./invitation";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const INVITATION_NOT_FOUND = "invitation_not_found";

export function isInvitationToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export async function loadInvitation(
  token: string,
): Promise<Read<InvitationView>> {
  if (!isInvitationToken(token)) return readError(INVITATION_NOT_FOUND, 404);
  if (isFixtureMode()) {
    const invitation = fixtureInvitation(token);
    return invitation
      ? readOk(invitation)
      : readError(INVITATION_NOT_FOUND, 404);
  }

  const { withSystemDb } = await import("@oxagen/database");
  // tenancy: unscoped seam (the invitee holds no membership in the invitation's org yet)
  const row = await withSystemDb(async (tx) => {
    const invitation = await tx.query.invitations.findFirst({
      where: (inv, { eq }) => eq(inv.publicId, token),
      columns: {
        publicId: true,
        orgId: true,
        email: true,
        role: true,
        status: true,
        invitedByUserId: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    if (!invitation) return null;
    const [org, inviter] = await Promise.all([
      tx.query.organizations.findFirst({
        where: (o, { eq }) => eq(o.id, invitation.orgId),
        columns: { name: true, slug: true },
      }),
      tx.query.users.findFirst({
        where: (u, { eq }) => eq(u.id, invitation.invitedByUserId),
        columns: { displayName: true },
      }),
    ]);
    return org
      ? { invitation, org, inviterName: inviter?.displayName ?? null }
      : null;
  });
  if (!row) return readError(INVITATION_NOT_FOUND, 404);

  const role = toOrgRole(row.invitation.role);
  const parsed = InvitationView.safeParse({
    token: row.invitation.publicId,
    orgName: row.org.name,
    orgSlug: row.org.slug,
    email: row.invitation.email,
    role,
    status: row.invitation.status,
    inviterName: row.inviterName,
    invitedAt: row.invitation.createdAt.toISOString(),
    expiresAt: row.invitation.expiresAt
      ? row.invitation.expiresAt.toISOString()
      : null,
  });
  return parsed.success
    ? readOk(parsed.data)
    : readError("invitation_unreadable", 500);
}
