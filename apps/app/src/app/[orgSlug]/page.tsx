import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export default async function OrgHome({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const org = await resolveOrg(orgSlug);
  const rows = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ slug: schema.workspaces.slug })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, org.id))
          .limit(1),
      ),
  );
  if (rows[0]) redirect(`/${orgSlug}/${rows[0].slug}`);
  // No workspaces in this org yet — send the user to the creation page.
  redirect(`/${orgSlug}/new-workspace`);
}
