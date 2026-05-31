import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function AutomationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Agents", href: workspace.automation.agents(ctx) },
    { label: "Playbooks", href: workspace.automation.playbooks(ctx) },
    { label: "Events", href: workspace.automation.events(ctx) },
    { label: "Triggers", href: workspace.automation.triggers(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Automation"
        description="Agent configurations, playbooks, events, and triggers."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.chat(ctx) },
              { label: "Automation" },
            ]}
          />
        }
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
