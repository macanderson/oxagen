import type { Metadata } from "next";
import "@oxagen/handlers/register";
import { resolveStudioScope } from "@/lib/studio/scope";
import {
  installPlugin,
  installBulkPlugin,
} from "../../settings/plugins/plugin-actions";
import { BrowsePanel } from "./browse-panel";

export const metadata: Metadata = {
  title: "Browse | Marketplace",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Marketplace → Browse — the plugin catalog.
 *
 * View is open to any workspace member; install is gated by canManage inside
 * installPlugin/installBulkPlugin (see settings/plugins/plugin-actions.ts).
 * Data comes from GET /api/v1/plugin/catalog/browse (plugin.catalog.browse
 * contract) — see browse-panel.tsx.
 */
export default async function MarketplaceBrowsePage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  // Gate: session + org membership. canManage is not needed for viewing —
  // the install actions themselves enforce it.
  await resolveStudioScope(orgSlug, workspaceSlug);

  return (
    <BrowsePanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
    />
  );
}
