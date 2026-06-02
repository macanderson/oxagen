import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
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

  const tabs = [
    { label: "People", href: org.members(ctx) },
    { label: "Pending", href: `/${orgSlug}/members/pending`, badge: 2 },
    { label: "Invitations", href: `/${orgSlug}/members/invitations` },
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
