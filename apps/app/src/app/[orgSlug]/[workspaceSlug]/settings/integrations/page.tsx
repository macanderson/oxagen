import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import {
  WorkspaceIntegrationsPanel,
  type WorkspaceMcpInstall,
} from "./workspace-integrations-panel";
import { setWorkspacePluginEnabledAction, setSecretAction } from "./integration-actions";

export const dynamic = "force-dynamic";

export default async function SettingsIntegrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Read viewer workspace role
  const [wsRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.workspaceUsers.role })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, ws.id),
              eq(schema.workspaceUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );

  const wsRole = wsRoleRow?.role ?? "viewer";
  const canManage = ["owner", "admin"].includes(wsRole.toLowerCase());

  // Fetch the workspace-scoped installed integration plugins.
  const orgListings = await runInTenantScope(
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
              eq(schema.pluginInstalledPlugins.pluginType, "integration"),
            ),
          )
          .orderBy(schema.pluginInstalledPlugins.name),
      ),
  ).catch(() => [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[]);

  // Fetch workspace-level install rows to get per-listing enabled state + health.
  // Project ONLY non-secret display columns: this data crosses into the client
  // component below, and the full row carries `authConfig` (a live bearer token).
  // Never `.select()` the whole row here.
  const wsInstalls = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            orgListingId: schema.mcpServers.orgListingId,
            enabled: schema.mcpServers.enabled,
            healthStatus: schema.mcpServers.healthStatus,
            lastHealthcheckAt: schema.mcpServers.lastHealthcheckAt,
          })
          .from(schema.mcpServers)
          .where(eq(schema.mcpServers.workspaceId, ws.id)),
      ),
  ).catch(() => [] as WorkspaceMcpInstall[]);

  // Build a map: orgListingId → sanitized workspace install row
  const wsInstallMap: Record<string, WorkspaceMcpInstall> = {};
  for (const row of wsInstalls) {
    if (row.orgListingId) wsInstallMap[row.orgListingId] = row;
  }

  return (
    <WorkspaceIntegrationsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      orgListings={orgListings}
      wsInstallMap={wsInstallMap}
      setEnabledAction={setWorkspacePluginEnabledAction}
      setSecretAction={setSecretAction}
    />
  );
}
