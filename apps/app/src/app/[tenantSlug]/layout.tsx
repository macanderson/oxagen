import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveTenant } from "@/lib/resolve-tenant";
import { AppShell } from "@/components/shell/app-shell";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { tenantSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);

  const [tenantsRows, workspacesRows] = await Promise.all([
    db()
      .select({ publicId: schema.tenants.publicId, slug: schema.tenants.slug, name: schema.tenants.name })
      .from(schema.tenantUsers)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantUsers.tenantId))
      .where(eq(schema.tenantUsers.userId, session.user.id)),
    db()
      .select({
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.tenantId, tenant.id)),
  ]);

  return (
    <AppShell tenant={tenant} availableTenants={tenantsRows} availableWorkspaces={workspacesRows}>
      {children}
    </AppShell>
  );
}
