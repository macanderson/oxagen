import { and, count, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { resolveOrg } from "@/lib/resolve-org";
import { org } from "@/lib/routes";

// Sentinel workspaceId for org-only routes (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export default async function MembersLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  // Drive the Pending badge from real data: invitations sent but not yet
  // accepted (status "pending"). resolveOrg is request-cached, so this shares
  // the slug→tenant lookup with the page RSC.
  // Org-only route — sentinel workspaceId.
  const tenant = await resolveOrg(orgSlug);
  const pendingRows = await runInTenantScope(
    { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ pendingCount: count() })
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.orgId, tenant.id),
              eq(schema.invitations.status, "pending"),
            ),
          ),
      ),
  );
  const pendingCount = pendingRows[0]?.pendingCount ?? 0;

  const tabs = [
    { label: "People", href: org.members(ctx) },
    {
      label: "Invited",
      href: `/${orgSlug}/members/pending`,
      badge: pendingCount,
    },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Members"
        description="Manage who has access to this organization."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Members" />
    </div>
  );
}
