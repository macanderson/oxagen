import { eq, and } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getOrgSeatUsage } from "@oxagen/billing";
import { resolveOrg } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { MembersPanel } from "@/components/workspace/members-panel";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [tenant, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  // Viewer's role in this org — for UI gating of mutating controls.
  const viewerRow = session?.user
    ? (
        await db()
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, tenant.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1)
      )[0] ?? null
    : null;

  const viewerRole = viewerRow?.role ?? "member";

  const [memberRows, pendingInvitations, seatUsage] = await Promise.all([
    db()
      .select({
        publicId: schema.orgUsers.publicId,
        role: schema.orgUsers.role,
        joinedAt: schema.orgUsers.joinedAt,
        email: schema.users.email,
        displayName: schema.users.displayName,
      })
      .from(schema.orgUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
      .where(eq(schema.orgUsers.orgId, tenant.id)),

    db()
      .select({
        publicId: schema.invitations.publicId,
        email: schema.invitations.email,
        role: schema.invitations.role,
        createdAt: schema.invitations.createdAt,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, tenant.id),
          eq(schema.invitations.status, "pending"),
        ),
      ),

    getOrgSeatUsage(tenant.id),
  ]);

  return (
    <MembersPanel
      orgSlug={orgSlug}
      members={memberRows.map((r) => ({
        publicId: r.publicId,
        email: r.email,
        displayName: r.displayName,
        role: r.role,
        joinedAt: r.joinedAt,
      }))}
      pendingInvitations={pendingInvitations.map((i) => ({
        publicId: i.publicId,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt?.toISOString() ?? null,
        expiresAt: i.expiresAt?.toISOString() ?? null,
      }))}
      seatUsage={seatUsage}
      viewerRole={viewerRole}
    />
  );
}
