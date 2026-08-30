import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSession } from "@/lib/session";

export default async function RootPage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");

  // Identity resolution: reads the user's org memberships BEFORE a tenant scope
  // exists (pre-org-selection). withSystemDb bypasses RLS deliberately
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        orgSlug: schema.organizations.slug,
        workspaceSlug: schema.workspaces.slug,
      })
      .from(schema.orgUsers)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgUsers.orgId),
      )
      .leftJoin(
        schema.workspaces,
        eq(schema.workspaces.orgId, schema.organizations.id),
      )
      .where(eq(schema.orgUsers.userId, session.user.id))
      .limit(1),
  );

  const first = rows[0];
  if (!first) redirect("/new-organization");
  if (first.workspaceSlug) redirect(`/${first.orgSlug}/${first.workspaceSlug}`);
  redirect(`/${first.orgSlug}`);
}
