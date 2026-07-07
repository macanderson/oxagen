import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Studio layout — the Build surface for interactive agents.
 *
 * Tabs: Agents (the builder), Skills, Tools. The Agent Builder routes
 * (studio/agents/new, studio/agents/[id]) render below these tabs; they use a
 * nested full-width layout for the multi-step wizard.
 */
export default async function StudioLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Agents", href: workspace.studio.agents(ctx) },
    { label: "Skills", href: workspace.studio.skills(ctx) },
    { label: "Tools", href: workspace.studio.tools(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Studio"
        description="Build interactive agents: define skills, pick tools, connect MCP servers, and launch."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
