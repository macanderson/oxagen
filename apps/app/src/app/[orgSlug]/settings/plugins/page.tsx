import { eq } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { OrgPluginsPanel } from "./org-plugins-panel";
import {
  installPluginAction,
  installBulkPluginAction,
  setOrgPluginEnabledAction,
  uninstallPluginAction,
  addDenylistAction,
  removeDenylistAction,
  addRegistryAction,
  removeRegistryAction,
} from "./plugin-actions";
import { setAuthAlertsAction } from "./plugin-actions-alerts";

// Sentinel workspaceId for org-only routes. — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function OrgPluginsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);

  // Read viewer role (same pattern as billing/subscription/page.tsx).
  const [viewerRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(eq(schema.orgUsers.userId, session.user.id))
          .limit(1),
      ),
  );

  const viewerRole = viewerRoleRow?.role ?? "member";
  const canManage = ["owner", "admin"].includes(viewerRole.toLowerCase());

  const ctx = {
    orgId: org.id,
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch registries via capability and org listings + denylist directly from DB.
  type RegistryItem = {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    isDefaultSeed: boolean;
    lastSyncedAt: string | null;
  };

  const [registriesResult, listings, denylisted] = await Promise.all([
    (invoke("plugin.registry.list", {}, ctx, { surface: "agent" }) as Promise<{ registries: RegistryItem[] }>).catch(() => ({
      registries: [] as RegistryItem[],
    })),
    // plugin.org.list capability not yet shipped — read directly from DB.
    runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginOrgListings)
          .where(eq(schema.pluginOrgListings.orgId, org.id))
          .orderBy(schema.pluginOrgListings.name),
      ),
    ).catch(() => [] as (typeof schema.pluginOrgListings.$inferSelect)[]),
    runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginOrgDenylist)
          .where(eq(schema.pluginOrgDenylist.orgId, org.id))
          .orderBy(schema.pluginOrgDenylist.serverName),
      ),
    ).catch(() => [] as (typeof schema.pluginOrgDenylist.$inferSelect)[]),
  ]);

  // Read auth-alert settings from org.settings JSONB if present.
  const [orgRow] = await withSystemDb((tx) =>
    tx
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id))
      .limit(1),
  ).catch(() => [null]);

  const authAlertsRaw =
    orgRow?.settings &&
    typeof orgRow.settings === "object" &&
    "mcp_auth_alerts" in orgRow.settings
      ? (orgRow.settings as Record<string, unknown>).mcp_auth_alerts
      : null;
  const authAlerts =
    authAlertsRaw && typeof authAlertsRaw === "object"
      ? (authAlertsRaw as { send_email?: boolean; roles?: string[] })
      : null;

  return (
    <OrgPluginsPanel
      orgSlug={orgSlug}
      canManage={canManage}
      registries={registriesResult.registries}
      listings={listings}
      denylisted={denylisted}
      initialSendEmail={authAlerts?.send_email ?? false}
      initialAlertRoles={authAlerts?.roles ?? ["Owner", "Admin"]}
      setAuthAlertsAction={setAuthAlertsAction}
      installAction={installPluginAction}
      installBulkAction={installBulkPluginAction}
      setEnabledAction={setOrgPluginEnabledAction}
      uninstallAction={uninstallPluginAction}
      addDenylistAction={addDenylistAction}
      removeDenylistAction={removeDenylistAction}
      addRegistryAction={addRegistryAction}
      removeRegistryAction={removeRegistryAction}
    />
  );
}
