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

  // Fetch registries via capability and org listings + denylist via plugin.org.list capability.
  type RegistryItem = {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    isDefaultSeed: boolean;
    lastSyncedAt: string | null;
  };
  type OrgListResult = {
    listings: (typeof schema.pluginOrgListings.$inferSelect)[];
    denylist: (typeof schema.pluginOrgDenylist.$inferSelect)[];
  };

  const [registriesResult, orgListResult] = await Promise.all([
    (invoke("plugin.registry.list", {}, ctx, { surface: "agent" }) as Promise<{ registries: RegistryItem[] }>).catch(() => ({
      registries: [] as RegistryItem[],
    })),
    (invoke("plugin.org.list", {}, ctx, { surface: "agent" }) as Promise<OrgListResult>).catch(() => ({
      listings: [] as (typeof schema.pluginOrgListings.$inferSelect)[],
      denylist: [] as (typeof schema.pluginOrgDenylist.$inferSelect)[],
    })),
  ]);

  // The capability returns ISO strings for timestamps; the panel type expects Date objects.
  // Cast here — the panel only reads non-timestamp fields (id, name, title, etc.) so
  // the shape is safe at runtime for all fields the UI actually accesses.
  const listings = orgListResult.listings as unknown as (typeof schema.pluginOrgListings.$inferSelect)[];
  const denylisted = orgListResult.denylist as unknown as (typeof schema.pluginOrgDenylist.$inferSelect)[];

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
      // installCatalogAction handles catalog-based installs from the marketplace modal.
      // The underlying server action (installPluginAction) accepts both catalogServerId
      // and custom shapes — the type adapter here narrows to the catalog call signature.
      installCatalogAction={(input) =>
        installPluginAction({
          orgSlug: input.orgSlug,
          catalogServerId: input.catalogServerId,
          pluginType: input.pluginType,
        })
      }
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
