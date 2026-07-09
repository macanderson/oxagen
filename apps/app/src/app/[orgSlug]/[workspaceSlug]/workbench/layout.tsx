import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Workbench layout — the Build surface for interactive agents.
 *
 * Tabs: Agents (the builder) and Agent Tools — the single home for
 * everything an agent can be equipped with (skills, MCP servers,
 * capabilities). The Agent Builder routes (workbench/agents/new,
 * workbench/agents/[id]) render below these tabs; they use a nested
 * full-width layout for the multi-step wizard.
 */
export default async function WorkbenchLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Agents", href: workspace.workbench.agents(ctx) },
    { label: "Agent Tools", href: workspace.workbench.tools.root(ctx) },
    { label: "Sandboxes", href: workspace.workbench.sandboxes(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Workbench"
        description="Build interactive agents and equip them with skills, MCP servers, and capabilities."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
