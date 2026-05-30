import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";

export default async function OrgHome({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);
  const rows = await db()
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.orgId, tenant.id))
    .limit(1);
  if (rows[0]) redirect(`/${orgSlug}/${rows[0].slug}`);
  redirect(`/${orgSlug}/settings/members`);
}
