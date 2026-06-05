import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "General", href: workspace.settings.general(ctx) },
    { label: "Members", href: workspace.settings.members(ctx) },
    { label: "Models", href: workspace.settings.models(ctx) },
    { label: "Model Keys", href: workspace.settings.modelKeys(ctx) },
    { label: "Brand Kits", href: workspace.settings.brandKits(ctx) },
    { label: "Integrations", href: workspace.settings.integrations(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Settings"
        description="Workspace configuration, members, and integrations."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Settings" },
            ]}
          />
        }
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
