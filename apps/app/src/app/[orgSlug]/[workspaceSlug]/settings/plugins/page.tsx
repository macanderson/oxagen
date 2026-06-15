import type { Metadata } from "next";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspacePluginsPanel, type InstalledPlugin } from "./workspace-plugins-panel";
import { installPlugin, installBulkPlugin, togglePlugin, uninstallPlugin } from "./plugin-actions";

export const metadata: Metadata = {
  title: "Plugins | Workspace Settings",
};

export const dynamic = "force-dynamic";

// Sentinel workspaceId for org-only DB queries — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkspacePluginsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Fetch the org allow-list (plugins available to this workspace)
  const orgListings = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginOrgListings)
          .where(
            and(
              eq(schema.pluginOrgListings.orgId, org.id),
              eq(schema.pluginOrgListings.enabled, true),
            ),
          )
          .orderBy(schema.pluginOrgListings.name),
      ),
  ).catch(() => [] as (typeof schema.pluginOrgListings.$inferSelect)[]);

  // Fetch workspace-level install rows to get per-listing enabled state
  const wsInstalls = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.mcpServers)
          .where(eq(schema.mcpServers.workspaceId, ws.id)),
      ),
  ).catch(() => [] as (typeof schema.mcpServers.$inferSelect)[]);

  // Build a map: orgListingId → workspace install row
  const wsInstallMap: Record<string, (typeof wsInstalls)[number]> = {};
  for (const row of wsInstalls) {
    if (row.orgListingId) wsInstallMap[row.orgListingId] = row;
  }

  // Shape into InstalledPlugin (org allow-list items that have a ws install row)
  const initialPlugins: InstalledPlugin[] = orgListings
    .filter((listing) => wsInstallMap[listing.id] !== undefined)
    .map((listing) => {
      const wsRow = wsInstallMap[listing.id];
      return {
        id: listing.id,
        name: listing.name,
        title: listing.title,
        description: listing.description,
        iconUrl: listing.iconUrl,
        pluginType: listing.pluginType,
        authKind: listing.authKind,
        enabled: listing.enabled,
        wsEnabled: wsRow?.enabled ?? false,
      };
    });

  return (
    <WorkspacePluginsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      orgId={org.id}
      workspaceId={ws.id}
      initialPlugins={initialPlugins}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
      toggleAction={togglePlugin}
      uninstallAction={uninstallPlugin}
    />
  );
}
