import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { OrgGeneralForm } from "./general-form";
import { updateOrgGeneralAction } from "./general-action";

export const dynamic = "force-dynamic";

export default async function OrgGeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug } = await params;

  const org = await resolveOrg(orgSlug);
  await assertOrgMember(org.id, session.user.id);

  // Fetch the org's mutable fields and the caller's role in a single query.
  // Org-only route — sentinel workspaceId. — OXA-1515
  const rows = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            name: schema.organizations.name,
            slug: schema.organizations.slug,
            avatarUrl: schema.organizations.avatarUrl,
            role: schema.orgUsers.role,
          })
          .from(schema.organizations)
          .innerJoin(
            schema.orgUsers,
            and(
              eq(schema.orgUsers.orgId, schema.organizations.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .where(eq(schema.organizations.id, org.id))
          .limit(1),
      ),
  );

  const row = rows[0];
  if (!row) {
    // Defensive: assertOrgMember above should have thrown notFound() first.
    return (
      <p className="text-sm text-muted-foreground">
        Unable to load organization settings. Please try again.
      </p>
    );
  }

  // Owners and admins may edit. Check is case-insensitive to match DB values
  // that may be stored as "Owner", "Admin", "owner", "admin", etc.
  const canEdit = ["owner", "admin"].includes(row.role.toLowerCase());

  // Bind orgSlug into the action so the client only passes FormData.
  const boundAction = updateOrgGeneralAction.bind(null, orgSlug);

  return (
    <OrgGeneralForm
      orgSlug={orgSlug}
      initialName={row.name}
      initialSlug={row.slug}
      initialAvatarUrl={row.avatarUrl ?? ""}
      canEdit={canEdit}
      action={boundAction}
    />
  );
}
