import type { Metadata } from "next";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspacePluginsPanel } from "./workspace-plugins-panel";
import { shapeInstalledPlugins } from "./plugin-shape";
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

  // Fetch the org allow-list (all non-deleted listings for this org). We
  // intentionally do NOT filter by `enabled` here: capability packs are shown
  // even when org-disabled so the workspace toggle can re-enable them. The
  // per-plugin-type visibility/enabled rules live in shapeInstalledPlugins().
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
              isNull(schema.pluginOrgListings.deletedAt),
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

  // Shape into InstalledPlugin. Capability packs (org-level) show from the org
  // listing alone; MCP servers / integrations / content tools require a
  // workspace install row. See shapeInstalledPlugins() for the full rules.
  const initialPlugins = shapeInstalledPlugins(orgListings, wsInstalls);

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
