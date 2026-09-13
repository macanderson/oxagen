import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { org } from "@/lib/routes";

/**
 * Governance group layout — Hub · Capabilities · Policies tabs.
 * Mirrors the Security/Access org layouts (PageHeader + PageTabs + mobile nav).
 * Org membership is asserted by the parent [orgSlug] layout; pages and actions
 * add their own explicit gates before any invoke().
 */
export default async function GovernanceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = { orgSlug };

  const tabs = [
    { label: "Hub", href: org.governance.root(ctx) },
    { label: "Capabilities", href: org.governance.capabilities(ctx) },
    { label: "Policies", href: org.governance.policies(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Governance"
        description="The accountability chain — identity, knowledge scope, permitted action, commercial terms, verified outcome, audit record."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Governance" />
    </div>
  );
}
