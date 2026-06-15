/**
 * Org plugins settings page — wired to live contracts.
 *
 * Fetches installed plugins, registries, and denylist via plugin.org.list and plugin.registry.list.
 * Displays org-level plugin management UI with marketplace integration.
 */

import { notFound } from "next/navigation";
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
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { withSystemDb, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

interface PageProps {
  params: Promise<{
    orgSlug: string;
  }>;
}

export default async function OrgPluginsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);

  if (!org) notFound();

  // Determine if user can manage plugins (owner/admin role).
  let canManage = false;
  try {
    const [orgUser] = await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      () =>
        withSystemDb((tx) =>
          tx
            .select({ role: schema.orgUsers.role })
            .from(schema.orgUsers)
            .where(
              and(
                eq(schema.orgUsers.orgId, org.id),
                eq(schema.orgUsers.userId, session.user.id),
              ),
            )
            .limit(1),
        ),
    );
    canManage = !!orgUser && ["owner", "admin"].includes(orgUser.role);
  } catch (e) {
    console.error("Failed to determine org role:", e);
    // Default to false if we can't determine role
  }

  // Build context for invoke calls.
  const ctx = {
    orgId: org.id,
    workspaceId: ORG_ONLY_WS,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch plugin listings and denylist.
  let listings = [] as Parameters<typeof OrgPluginsPanel>[0]["listings"];
  let denylisted = [] as Parameters<typeof OrgPluginsPanel>[0]["denylisted"];
  try {
    const result = await invoke(
      "plugin.org.list",
      {},
      ctx,
      { surface: "agent" },
    );
    const typed = result as {
      listings: typeof listings;
      denylist: typeof denylisted;
    };
    listings = typed.listings;
    denylisted = typed.denylist;
  } catch (e) {
    console.error("Failed to fetch plugin listings:", e);
    // Continue with empty arrays if contract fails
  }

  // Fetch registries.
  let registries = [] as Parameters<typeof OrgPluginsPanel>[0]["registries"];
  try {
    const result = await invoke(
      "plugin.registry.list",
      {},
      ctx,
      { surface: "agent" },
    );
    const typed = result as { registries: typeof registries };
    registries = typed.registries;
  } catch (e) {
    console.error("Failed to fetch registries:", e);
    // Continue with empty arrays if contract fails
  }

  // Read mcp_auth_alerts from org settings.
  let initialSendEmail = false;
  let initialAlertRoles: string[] = ["Owner"];
  try {
    const [orgRow] = await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      () =>
        withSystemDb((tx) =>
          tx
            .select({ settings: schema.organizations.settings })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, org.id))
            .limit(1),
        ),
    );
    if (orgRow) {
      const raw = (orgRow.settings ?? {}) as Record<string, unknown>;
      const alerts = (raw["mcp_auth_alerts"] ?? {}) as Record<string, unknown>;
      if (typeof alerts["send_email"] === "boolean") {
        initialSendEmail = alerts["send_email"];
      }
      if (Array.isArray(alerts["roles"]) && alerts["roles"].length > 0) {
        initialAlertRoles = alerts["roles"] as string[];
      }
    }
  } catch (e) {
    console.error("Failed to fetch org auth alert settings:", e);
    // Safe defaults already set above
  }

  return (
    <OrgPluginsPanel
      orgSlug={orgSlug}
      workspaceSlug=""
      workspaceId={ORG_ONLY_WS}
      canManage={canManage}
      registries={registries}
      listings={listings}
      denylisted={denylisted}
      initialSendEmail={initialSendEmail}
      initialAlertRoles={initialAlertRoles}
      installCatalogAction={installPluginAction}
      installAction={installPluginAction}
      installBulkAction={installBulkPluginAction}
      setEnabledAction={setOrgPluginEnabledAction}
      uninstallAction={uninstallPluginAction}
      addDenylistAction={addDenylistAction}
      removeDenylistAction={removeDenylistAction}
      addRegistryAction={addRegistryAction}
      removeRegistryAction={removeRegistryAction}
      setAuthAlertsAction={setAuthAlertsAction}
    />
  );
}
