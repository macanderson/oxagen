import type { Metadata } from "next";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { WorkspacePluginsPanel } from "@/components/agent-tools/workspace-plugins-panel";
import { shapeInstalledPlugins } from "@/components/agent-tools/plugin-shape";
import {
  installPlugin,
  installBulkPlugin,
  togglePlugin,
  uninstallPlugin,
} from "@/lib/agent-tools/install-actions";

export const metadata: Metadata = {
  title: "Capabilities | Agent Tools",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Workbench → Agent Tools → Capabilities — installed plugin listings
 * (enable/disable, uninstall). Registry administration lives in
 * Settings → MCP Server Registries. All server actions flow through the
 * single install choke point in @/lib/agent-tools/install-actions.
 */
export default async function AgentToolsCapabilitiesPage({
  params,
}: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Fetch workspace-scoped installed plugins.
  const installedPluginsRead = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.orgId, org.id),
              eq(schema.pluginInstalledPlugins.workspaceId, ws.id),
              isNull(schema.pluginInstalledPlugins.deletedAt),
            ),
          )
          .orderBy(schema.pluginInstalledPlugins.name),
      ),
  ).then(
    (data) => ({ data, failed: false as const }),
    (err) => {
      // Non-fatal: render an empty list but surface a load-error notice so an
      // RLS/DB failure doesn't look like "no plugins installed" to the user.
      logger.error(
        { err, orgSlug, workspaceSlug },
        "agent-tools/capabilities: installed-plugins read failed — rendering empty list with load-error notice",
      );
      return {
        data: [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[],
        failed: true as const,
      };
    },
  );
  const installedPlugins = installedPluginsRead.data;
  const pluginsLoadError = installedPluginsRead.failed;

  const initialPlugins = shapeInstalledPlugins(installedPlugins);

  return (
    <WorkspacePluginsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      orgId={org.id}
      workspaceId={ws.id}
      initialPlugins={initialPlugins}
      loadError={pluginsLoadError}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
      toggleAction={togglePlugin}
      uninstallAction={uninstallPlugin}
    />
  );
}
