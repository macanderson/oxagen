/**
 * Members page — live data.
 *
 * Reads org members from org_users ⋈ users and pending invitations from
 * invitations (status = 'pending'). Seat usage from billing.getOrgSeatUsage.
 * The viewer's own role gates the mutating controls inside MembersPanel.
 */

import { eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getOrgSeatUsage } from "@oxagen/billing";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember, getOrgRole } from "@/lib/resolve-org";
import { MembersPanel } from "@/components/workspace/members-panel";

// Sentinel workspaceId for org-only routes (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  const [org, session] = await Promise.all([
    resolveOrg(orgSlug),
    getSessionOrRedirect(),
  ]);

  const viewerUserId = session.user.id;

  // IDOR guard: assert the viewer is a member before loading any org data.
  // Unconditional — a missing session redirects to /login above, so there is no
  // path on which the roster, member emails, or invitations load ungated.
  await assertOrgMember(org.id, viewerUserId);

  // Run all three reads in parallel inside the tenant scope.
  const [members, pendingInvitations, seatUsage, viewerRole] =
    await Promise.all([
      runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
        withTenantDb((tx) =>
          tx
            .select({
              publicId: schema.orgUsers.publicId,
              userId: schema.orgUsers.userId,
              role: schema.orgUsers.role,
              joinedAt: schema.orgUsers.joinedAt,
              email: schema.users.email,
              displayName: schema.users.displayName,
            })
            .from(schema.orgUsers)
            .innerJoin(
              schema.users,
              eq(schema.users.id, schema.orgUsers.userId),
            )
            .where(eq(schema.orgUsers.orgId, org.id)),
        ),
      ),
      runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
        withTenantDb((tx) =>
          tx
            .select({
              publicId: schema.invitations.publicId,
              email: schema.invitations.email,
              role: schema.invitations.role,
              createdAt: schema.invitations.createdAt,
              expiresAt: schema.invitations.expiresAt,
            })
            .from(schema.invitations)
            .where(eq(schema.invitations.orgId, org.id)),
        ),
      ).then((rows) =>
        rows
          .filter((r) => r.publicId !== null)
          .map((r) => ({
            publicId: r.publicId,
            email: r.email,
            role: r.role,
            createdAt: r.createdAt ? r.createdAt.toISOString() : null,
            expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          })),
      ),
      runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
        getOrgSeatUsage(org.id),
      ),
      getOrgRole(org.id, viewerUserId),
    ]);

  return (
    <MembersPanel
      orgSlug={orgSlug}
      members={members.map((m) => ({
        publicId: m.publicId,
        userId: m.userId,
        email: m.email,
        displayName: m.displayName ?? null,
        role: m.role,
        joinedAt: m.joinedAt,
      }))}
      pendingInvitations={pendingInvitations}
      seatUsage={seatUsage}
      viewerRole={viewerRole ?? "member"}
      viewerUserId={viewerUserId}
    />
  );
}
