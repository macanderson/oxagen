import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";

export default async function AccessLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  const tabs = [
    { label: "Grants", href: org.access.grants(ctx) },
    { label: "Roles", href: org.access.roles(ctx) },
    { label: "Policies", href: org.access.policies(ctx) },
    { label: "Requests", href: org.access.requests(ctx), badge: 5 },
    { label: "Sessions", href: org.access.sessions(ctx) },
    { label: "Identities", href: org.access.identities(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Access"
        description="Capability grants, roles, policies, and principal identities."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
