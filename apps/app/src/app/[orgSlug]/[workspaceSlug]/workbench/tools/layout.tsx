import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Agent Tools layout — the single home for everything an agent can be
 * equipped with. Sections:
 *
 *   All Tools    — read-only catalog of every equipable tool (post-filtering)
 *   Skills       — workspace skills: list, create (AI-drafted), versions
 *   MCP Servers  — installed MCP servers: authenticate, reconnect, install
 *   Capabilities — installed first-party capability packs
 *
 * Discovery/install of NEW tools lives in the Marketplace (Agent Tools side);
 * everything here manages what the workspace already has. This is the ONLY
 * secondary nav on these pages — Agents / Environments / Sandboxes are
 * first-class sidebar destinations, not tabs. Desktop: tabs. Mobile: the same
 * bottom-sheet section switcher the settings pages use (ADR-026 parity).
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
    {
      label: "Capabilities",
      href: workspace.workbench.tools.capabilities(ctx),
    },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Agent Tools"
        description="Everything agents in this workspace can be equipped with — tools, skills, MCP servers, and capability packs."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Agent Tools" />
    </div>
  );
}
