import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveTenant } from "@/lib/resolve-tenant";

export default async function TenantHome({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);
  const rows = await db()
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.tenantId, tenant.id))
    .limit(1);
  if (rows[0]) redirect(`/${tenantSlug}/${rows[0].slug}`);
  redirect(`/${tenantSlug}/settings/members`);
}
