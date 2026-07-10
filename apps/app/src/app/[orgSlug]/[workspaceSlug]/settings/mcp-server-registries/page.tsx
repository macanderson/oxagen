import type { Metadata } from "next";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { docsUrl } from "@/lib/docs-url";
import { RegistryManager } from "@/components/agent-tools/registry-manager";
import { addRegistry, removeRegistry } from "@/lib/agent-tools/install-actions";

export const metadata: Metadata = {
  title: "MCP Server Registries | Settings",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Settings → MCP Server Registries — the ONE place registry sources are
 * administered (list, add, remove). Registries are the catalogs the
 * marketplace and the Workbench MCP-install flows discover servers from;
 * the servers themselves are managed in Workbench → Agent Tools → MCP
 * Servers. All server actions flow through the single install choke point
 * in @/lib/agent-tools/install-actions.
 */
export default async function McpServerRegistriesPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

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
    const result = await invoke("list_plugin_registries", {}, ctx, {
      surface: "agent",
    });
    const typed = result as { registries: typeof initialRegistries };
    initialRegistries = typed.registries;
  } catch (err) {
    // Non-fatal: registry list degrades to empty — but never silently.
    logger.error(
      { err, orgSlug, workspaceSlug },
      "settings/mcp-server-registries: plugin.registry.list failed — rendering empty registry list",
    );
  }

  return (
    <RegistryManager
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initialRegistries={initialRegistries}
      docsBaseUrl={docsUrl()}
      addRegistryAction={addRegistry}
      removeRegistryAction={removeRegistry}
    />
  );
}
