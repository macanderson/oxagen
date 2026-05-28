import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSession } from "@/lib/session";

export default async function RootPage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");

  const rows = await db()
    .select({
      tenantSlug: schema.tenants.slug,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.tenantUsers)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantUsers.tenantId))
    .leftJoin(schema.workspaces, eq(schema.workspaces.tenantId, schema.tenants.id))
    .where(eq(schema.tenantUsers.userId, session.user.id))
    .limit(1);

  const first = rows[0];
  if (!first) redirect("/new-tenant");
  if (first.workspaceSlug) redirect(`/${first.tenantSlug}/${first.workspaceSlug}`);
  redirect(`/${first.tenantSlug}`);
}
