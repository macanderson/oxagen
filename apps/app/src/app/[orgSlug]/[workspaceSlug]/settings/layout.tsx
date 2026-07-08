import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { MobileSettingsNav, SettingsNav } from "@/components/ui/settings-nav";
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
    { label: "Budget", href: workspace.settings.budget(ctx) },
    { label: "GitHub", href: workspace.settings.github(ctx) },
    { label: "Prompts", href: workspace.settings.prompts(ctx) },
    { label: "Knowledge", href: workspace.settings.knowledge(ctx) },
    { label: "Memory", href: workspace.settings.memory(ctx) },
    { label: "Environments", href: workspace.settings.environments(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Settings"
        description="Workspace configuration, members, and models."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: workspaceSlug, href: workspace.ask(ctx) },
              { label: "Settings" },
            ]}
          />
        }
      />
      {/* Desktop: fixed sidebar. Mobile: full-width content + MobileSettingsNav,
          a thumb-reachable bottom-sheet switcher (same items — parity per ADR-026). */}
      <div className="flex flex-col md:flex-row md:gap-8">
        <aside className="hidden w-48 shrink-0 md:block">
          <SettingsNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
        <MobileSettingsNav items={navItems} label="Workspace settings" />
      </div>
    </div>
  );
}
