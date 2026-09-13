import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { MobileSettingsNav } from "@/components/ui/settings-nav";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Marketplace layout — the discovery + install surface, two sides:
 *
 *   Agent Tools  — skills, MCP servers, and capabilities agents can be
 *                  equipped with. Installs land in Workbench → Agent Tools.
 *   Integrations — data connectors that ingest external sources into the
 *                  knowledge graph. Connecting opens the in-app setup wizard
 *                  at integrations/[connectorId] (GitHub is the exception: it
 *                  needs its own GitHub-App OAuth flow under Knowledge → Repos).
 *
 * Managing what is already installed does NOT live here — that is
 * Workbench → Agent Tools (skills / MCP servers / capabilities) and
 * Knowledge → Repos (integrations).
 */
export default async function MarketplaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Agent Tools", href: workspace.marketplace.agentTools(ctx) },
    { label: "Integrations", href: workspace.marketplace.integrations(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Marketplace"
        description="Discover and install agent tools and integrations."
      />
      <PageTabs tabs={tabs} className="mb-6 max-md:hidden" />
      {children}
      <MobileSettingsNav items={tabs} label="Marketplace" />
    </div>
  );
}
