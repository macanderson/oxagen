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
      orgSlug: schema.organizations.slug,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.orgUsers)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
    .leftJoin(schema.workspaces, eq(schema.workspaces.orgId, schema.organizations.id))
    .where(eq(schema.orgUsers.userId, session.user.id))
    .limit(1);

  const first = rows[0];
  if (!first) redirect("/new-organization");
  if (first.workspaceSlug) redirect(`/${first.orgSlug}/${first.workspaceSlug}`);
  redirect(`/${first.orgSlug}`);
}
