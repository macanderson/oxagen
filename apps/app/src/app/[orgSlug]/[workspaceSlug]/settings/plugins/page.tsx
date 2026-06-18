import type { Metadata } from "next";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspacePluginsPanel } from "./workspace-plugins-panel";
import { shapeInstalledPlugins } from "./plugin-shape";
import { installPlugin, installBulkPlugin, togglePlugin, uninstallPlugin } from "./plugin-actions";
import { addRegistry, removeRegistry } from "./plugin-actions";
import { docsUrl } from "@/lib/docs-url";

export const metadata: Metadata = {
  title: "Plugins | Workspace Settings",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkspacePluginsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Fetch workspace-scoped installed plugins.
  const installedPlugins = await runInTenantScope(
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
  ).catch(() => [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[]);

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
    const result = await invoke("plugin.registry.list", {}, ctx, { surface: "agent" });
    const typed = result as typeof initialRegistries extends Array<infer T> ? { registries: T[] } : never;
    initialRegistries = typed.registries;
  } catch {
    // Non-fatal: registry list degrades gracefully to empty.
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
