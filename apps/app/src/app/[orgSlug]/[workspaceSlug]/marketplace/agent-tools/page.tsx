import type { Metadata } from "next";
import "@oxagen/handlers/register";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  installPlugin,
  installBulkPlugin,
} from "@/lib/agent-tools/install-actions";
import { BrowsePanel } from "./browse-panel";

export const metadata: Metadata = {
  title: "Agent Tools | Marketplace",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Marketplace → Agent Tools — the catalog of installable agent tools:
 * skills, MCP servers, and capabilities.
 *
 * View is open to any workspace member; install is gated by canManage inside
 * installPlugin/installBulkPlugin (the single install choke point in
 * @/lib/agent-tools/install-actions). Data comes from
 * GET /api/v1/plugin/catalog/browse (plugin.catalog.browse contract) — see
 * browse-panel.tsx.
 */
export default async function MarketplaceAgentToolsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  // Gate: session + org membership. canManage is not needed for viewing —
  // the install actions themselves enforce it.
  await resolveWorkbenchScope(orgSlug, workspaceSlug);

  return (
    <BrowsePanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
    />
  );
}
