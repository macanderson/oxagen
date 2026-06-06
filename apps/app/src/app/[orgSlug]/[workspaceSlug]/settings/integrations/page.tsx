import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspaceIntegrationsPanel } from "./workspace-integrations-panel";
import { setWorkspacePluginEnabledAction, setSecretAction } from "./integration-actions";

// Sentinel workspaceId for org-only DB queries. — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

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

  // Fetch the org allow-list (plugins available to this workspace)
  const orgListings = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginOrgListings)
          .where(eq(schema.pluginOrgListings.orgId, org.id))
          .orderBy(schema.pluginOrgListings.name),
      ),
  ).catch(() => [] as (typeof schema.pluginOrgListings.$inferSelect)[]);

  // Fetch workspace-level install rows to get per-listing enabled state + health
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
  type WsInstall = (typeof wsInstalls)[number];
  const wsInstallMap: Record<string, WsInstall> = {};
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
