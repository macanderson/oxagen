import type { Metadata } from "next";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspacePluginsPanel } from "./workspace-plugins-panel";
import { shapeInstalledPlugins } from "./plugin-shape";
import { installPlugin, installBulkPlugin, togglePlugin, uninstallPlugin } from "./plugin-actions";
import { addRegistry, removeRegistry } from "./plugin-actions";
import { docsUrl } from "@/lib/docs-url";
import { GithubMcpCard } from "./github-mcp-card";
import {
  installGithubMcp,
  getGithubMcpInstallStatus,
} from "./github-mcp-actions";

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

  // Fetch GitHub MCP install status (non-fatal: card degrades to not-installed).
  const githubMcpStatus = await getGithubMcpInstallStatus({ orgSlug, workspaceSlug }).catch(
    () => ({
      installed: false,
      orgListingId: null,
      connected: false,
      healthStatus: null,
    }),
  );

  // Fetch workspace-scoped installed plugins.
  let pluginsLoadError = false;
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
  ).catch((err) => {
    // Non-fatal: render an empty list but surface a load-error notice so an
    // RLS/DB failure doesn't look like "no plugins installed" to the user.
    pluginsLoadError = true;
    logger.error(
      { err, orgSlug, workspaceSlug },
      "plugins: installed-plugins read failed — rendering empty list with load-error notice",
    );
    return [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[];
  });

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
    <div className="flex flex-col gap-8">
      {/* ── First-party featured integrations ────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Featured Integrations
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <GithubMcpCard
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            installed={githubMcpStatus.installed}
            orgListingId={githubMcpStatus.orgListingId}
            connected={githubMcpStatus.connected}
            healthStatus={githubMcpStatus.healthStatus}
            installAction={installGithubMcp}
          />
        </div>
      </section>

      {/* ── Installed plugins + registry marketplace ──────────────────────────── */}
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
    </div>
  );
}
