import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function OrgSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx: ScopeContext = { orgSlug };

  const tabs = [
    { label: "General", href: org.settings.general(ctx) },
    { label: "Plugins", href: org.settings.plugins(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Organization Settings"
        description="Configure your organization, manage plugins, and govern third-party integrations."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
