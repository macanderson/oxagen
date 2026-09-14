// The live onboarding adapter (plan §3.2 "Auth + onboarding gate", 🟡).
//
// Wired: the namespaces agent keys are minted in and the invitation behind a
// public token, both through withSystemDb. Not recorded (G15, M1): the gate
// state, the one-click installer with its single-use token, the first frame
// from a freshly wrapped agent, and the repository the installer saw. Those
// return NotBacked, and the screens say so instead of pretending to wait.
import "server-only";
import { notBackedFor } from "@/data/backing";
import { InvitationView, toOrgRole } from "@/data/contracts/invitations";
import { readError, readOk } from "@/data/not-backed";
import type { OnboardingReadPort } from "@/data/ports";

export const NAMESPACES_NOT_FOUND = "workspace_not_found";
export const INVITATION_NOT_FOUND = "invitation_not_found";

export const liveOnboarding: OnboardingReadPort = {
  async namespaces({ orgId, workspaceId }) {
    const { withSystemDb } = await import("@oxagen/database");
    // tenancy: unscoped seam (namespace columns only, by the org and workspace ids requireViewer admitted this user to)
    const namespaces = await withSystemDb(async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: (o, { and, eq, ne }) =>
          and(eq(o.id, orgId), ne(o.status, "deleted")),
        columns: { namespace: true },
      });
      if (!org) return null;
      const workspace = await tx.query.workspaces.findFirst({
        where: (w, { and, eq }) =>
          and(eq(w.orgId, orgId), eq(w.id, workspaceId)),
        columns: { namespace: true },
      });
      return workspace ? { org: org.namespace, ws: workspace.namespace } : null;
    });
    return namespaces
      ? readOk(namespaces)
      : readError(NAMESPACES_NOT_FOUND, 404);
  },

  // `org.invitations` by public id, with the organization and the inviter's
  // display name. Deliberate: the visitor is not yet a member of the
  // invitation's org (often not signed in at all), so no tenant scope can be
  // entered; the token is the capability, and the page shows only what the
  // invitation email already disclosed.
  async invitation(token) {
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

    const parsed = InvitationView.safeParse({
      token: row.invitation.publicId,
      orgName: row.org.name,
      orgSlug: row.org.slug,
      email: row.invitation.email,
      role: toOrgRole(row.invitation.role),
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
  },

  gate: () => Promise.resolve(notBackedFor("onboarding", "gate")),
  installerOffer: () =>
    Promise.resolve(notBackedFor("onboarding", "installerOffer")),
  firstFrameScript: () =>
    Promise.resolve(notBackedFor("onboarding", "firstFrameScript")),
  detectedRepository: () =>
    Promise.resolve(notBackedFor("onboarding", "detectedRepository")),
};
