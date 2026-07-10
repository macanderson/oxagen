import type { Metadata } from "next";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { docsUrl } from "@/lib/docs-url";
import { WorkspacePluginsPanel } from "@/components/agent-tools/workspace-plugins-panel";
import { shapeInstalledPlugins } from "@/components/agent-tools/plugin-shape";
import {
  installPlugin,
  installBulkPlugin,
  togglePlugin,
  uninstallPlugin,
  addRegistry,
  removeRegistry,
} from "@/lib/agent-tools/install-actions";

export const metadata: Metadata = {
  title: "Capabilities | Agent Tools",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Workbench → Agent Tools → Capabilities — installed plugin listings
 * (enable/disable, uninstall) plus the plugin-registry manager. Descended
 * from Settings → Plugins → Marketplace → Installed; both old routes now
 * redirect here. All server actions flow through the single install choke
 * point in @/lib/agent-tools/install-actions.
 */
export default async function AgentToolsCapabilitiesPage({ params }: PageProps) {
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

  // Fetch workspace-scoped registries via contract.
  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let initialRegistries: Array<{
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    isDefault: boolean;
  }> = [];
  try {
    const result = await invoke("list_plugin_registries", {}, ctx, { surface: "agent" });
    const typed = result as typeof initialRegistries extends Array<infer T> ? { registries: T[] } : never;
    initialRegistries = typed.registries;
  } catch (err) {
    // Non-fatal: registry list degrades to empty — but never silently.
    logger.error(
      { err, orgSlug, workspaceSlug },
      "agent-tools/capabilities: plugin.registry.list failed — rendering empty registry list",
    );
  }

  const initialPlugins = shapeInstalledPlugins(installedPlugins);

  return (
    <WorkspacePluginsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      orgId={org.id}
      workspaceId={ws.id}
      initialPlugins={initialPlugins}
      initialRegistries={initialRegistries}
      loadError={pluginsLoadError}
      docsBaseUrl={docsUrl()}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
      toggleAction={togglePlugin}
      uninstallAction={uninstallPlugin}
      addRegistryAction={addRegistry}
      removeRegistryAction={removeRegistry}
    />
  );
}
