import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { SettingsNav } from "@/components/ui/settings-nav";
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

  const navItems = [
    { label: "General", href: workspace.settings.general(ctx) },
    { label: "Members", href: workspace.settings.members(ctx) },
    { label: "Models", href: workspace.settings.models(ctx) },
    { label: "GitHub", href: workspace.settings.github(ctx) },
    { label: "Prompts", href: workspace.settings.prompts(ctx) },
    { label: "Plugins", href: workspace.settings.plugins(ctx) },
    { label: "Skills", href: workspace.settings.skills(ctx) },
    { label: "Knowledge", href: workspace.settings.knowledge(ctx) },
    { label: "Memory", href: workspace.settings.memory(ctx) },
    { label: "Environments", href: workspace.settings.environments(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Settings"
        description="Workspace configuration, members, and plugins."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Settings" },
            ]}
          />
        }
      />
      <div className="flex gap-8">
        <aside className="w-48 shrink-0">
          <SettingsNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
