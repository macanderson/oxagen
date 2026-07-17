import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { MobileSettingsNav, SettingsNav } from "@/components/ui/settings-nav";
import { workspace } from "@/lib/routes";
import { workspaceCrumb } from "@/lib/breadcrumbs";
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
  const wsCrumb = await workspaceCrumb(orgSlug, workspaceSlug);

  // Workspace configuration only. Anything about BUILDING with agents —
  // agents, tools, MCP servers, environments, sandboxes — lives in the
  // Workbench, never here. The one MCP concern that IS settings-shaped is
  // registry administration: which catalog sources the marketplace and MCP
  // install flows discover servers from.
  // web-app-2.0 Phase 2 consolidation: Models·Budget·Prompts·Memory-policy
  // merged into Agent Defaults, Members folded into General, and the
  // ontology/schema builder moved to Knowledge. Environments lives in the
  // Workbench (see settings/environments -> workbench/environments redirect),
  // so it is not a Settings tab here.
  const navItems = [
    { label: "General", href: workspace.settings.general(ctx) },
    { label: "Agent Defaults", href: workspace.settings.agentDefaults(ctx) },
    { label: "GitHub", href: workspace.settings.github(ctx) },
    { label: "MCP Registries", href: workspace.settings.mcpServerRegistries(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Settings"
        description="Workspace configuration, members, and models."
        breadcrumb={
          <Breadcrumb
            items={[wsCrumb, { label: "Settings" }]}
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
