import { and, count, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { resolveOrg } from "@/lib/resolve-org";
import { org } from "@/lib/routes";

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
  const tenant = await resolveOrg(orgSlug);
  const pendingRows = await db()
    .select({ pendingCount: count() })
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.orgId, tenant.id),
        eq(schema.invitations.status, "pending"),
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
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
