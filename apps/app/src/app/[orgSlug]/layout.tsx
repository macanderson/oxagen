import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { AppShell } from "@/components/shell/app-shell";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug } = await params;
  const org = await resolveOrg(orgSlug);

  const [orgsRows, workspacesRows] = await Promise.all([
    db()
      .select({ publicId: schema.organizations.publicId, slug: schema.organizations.slug, name: schema.organizations.name })
      .from(schema.orgUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
      .where(eq(schema.orgUsers.userId, session.user.id)),
    db()
      .select({
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.orgId, org.id)),
  ]);

  return (
    <AppShell org={org} availableOrgs={orgsRows} availableWorkspaces={workspacesRows}>
      {children}
    </AppShell>
  );
}
