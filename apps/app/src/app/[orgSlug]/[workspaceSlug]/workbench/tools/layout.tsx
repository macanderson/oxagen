import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Agent Tools layout — the single home for everything an agent can be
 * equipped with. Sub-tabs:
 *
 *   All Tools    — read-only catalog of every equipable tool (post-filtering)
 *   Skills       — workspace skills: list, create (AI-drafted), versions
 *   MCP Servers  — connected MCP servers, registries, custom endpoints
 *   Capabilities — installed first-party capability packs
 *
 * Discovery/install of NEW tools lives in the Marketplace (Agent Tools side);
 * everything here manages what the workspace already has.
 */
export default async function AgentToolsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "All Tools", href: workspace.workbench.tools.root(ctx) },
    { label: "Skills", href: workspace.workbench.tools.skills(ctx) },
    { label: "MCP Servers", href: workspace.workbench.tools.mcp(ctx) },
    { label: "Capabilities", href: workspace.workbench.tools.capabilities(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
