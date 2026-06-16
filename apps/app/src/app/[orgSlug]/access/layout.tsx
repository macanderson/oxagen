import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { getEnterpriseAccess } from "@/lib/enterprise";

export default async function AccessLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  // Enterprise-only section — redirect non-enterprise orgs to org root.
  const [session, resolvedOrg] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  void session; // membership already asserted by parent [orgSlug]/layout.tsx
  const { isEnterprise } = await getEnterpriseAccess(resolvedOrg.id);
  if (!isEnterprise) redirect(`/${orgSlug}`);

  const ctx = { orgSlug };

  const tabs = [
    { label: "Grants", href: org.access.grants(ctx) },
    { label: "Roles", href: org.access.roles(ctx) },
    { label: "Policies", href: org.access.policies(ctx) },
    { label: "Requests", href: org.access.requests(ctx) },
    { label: "Sessions", href: org.access.sessions(ctx) },
    { label: "Principals", href: org.access.principals(ctx) },
    { label: "Reviews", href: org.access.reviews(ctx) },
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
