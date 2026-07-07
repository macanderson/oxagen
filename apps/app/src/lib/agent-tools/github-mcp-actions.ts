"use server";
/**
 * github-mcp-actions.ts — server action for the GitHub MCP first-party plugin.
 *
 * Installs the GitHub MCP server into the workspace's plugin.installed_plugins
 * and then redirects to the MCP OAuth authorize flow to connect credentials.
 *
 * The install is idempotent (ON CONFLICT DO NOTHING): if the listing already
 * exists, this action returns the existing orgListingId so the caller can
 * direct the user to the OAuth connect route.
 *
 * Auth guard: workspace owner or admin (same as other plugin actions).
 * The MCP OAuth authorize route (GET /api/v1/mcp/oauth/authorize) enforces its
 * own assertMcpManager gate — this action only gates the install step.
 */
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { GITHUB_MCP_SERVER } from "@oxagen/plugins";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { resolveAgentToolsManager } from "./authz";

const InstallGithubMcpSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
});

export interface InstallGithubMcpResult {
  ok: boolean;
  /** UUID (raw internal id) of the plugin.installed_plugins row. */
  orgListingId?: string;
  /** OAuth authorize redirect URL the client should navigate to. */
  authorizeUrl?: string;
  error?: string;
}

/**
 * installGithubMcp — idempotently installs the GitHub MCP server listing for
 * this workspace, then returns the OAuth authorize URL the client should visit
 * to complete the credential connection.
 */
export async function installGithubMcp(
  input: z.infer<typeof InstallGithubMcpSchema>,
): Promise<InstallGithubMcpResult> {
  const parsed = InstallGithubMcpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug } = parsed.data;
  // Gate: the shared agent-tools authz seam (workspace owner/admin today,
  // Marketplace Install role later — see ./authz.ts).
  const auth = await resolveAgentToolsManager(orgSlug, workspaceSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { org, ws } = auth.scope;

  try {
    // Upsert: install or retrieve the existing listing (idempotent).
    const [row] = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () =>
        withTenantDb((tx) =>
          tx
            .insert(schema.pluginInstalledPlugins)
            .values({
              orgId: org.id,
              workspaceId: ws.id,
              pluginType: GITHUB_MCP_SERVER.pluginType,
              source: "custom" as const,
              name: GITHUB_MCP_SERVER.name,
              title: GITHUB_MCP_SERVER.title,
              description: GITHUB_MCP_SERVER.description,
              iconUrl: GITHUB_MCP_SERVER.iconUrl,
              endpointUrl: GITHUB_MCP_SERVER.endpointUrl,
              transport: GITHUB_MCP_SERVER.transport,
              authKind: GITHUB_MCP_SERVER.authKind,
              enabled: true,
            })
            .onConflictDoUpdate({
              target: [
                schema.pluginInstalledPlugins.orgId,
                schema.pluginInstalledPlugins.workspaceId,
                schema.pluginInstalledPlugins.pluginType,
                schema.pluginInstalledPlugins.name,
              ],
              set: { updatedAt: sql`now()` },
            })
            .returning({ id: schema.pluginInstalledPlugins.id }),
        ),
    );

    if (!row) {
      return { ok: false, error: "Plugin install failed — no row returned." };
    }

    // Return the OAuth authorize URL.  The authorize route requires:
    // orgSlug, workspaceSlug, orgListingId.
    const authorizeUrl =
      `/api/v1/mcp/oauth/authorize` +
      `?orgSlug=${encodeURIComponent(orgSlug)}` +
      `&workspaceSlug=${encodeURIComponent(workspaceSlug)}` +
      `&orgListingId=${encodeURIComponent(row.id)}`;

    return { ok: true, orgListingId: row.id, authorizeUrl };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "GitHub MCP install failed.",
    };
  }
}

/**
 * getGithubMcpInstallStatus — returns the current install state for GitHub MCP
 * in this workspace (listing id + whether credentials are connected).
 */
const GetStatusSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
});

export interface GithubMcpInstallStatus {
  installed: boolean;
  orgListingId: string | null;
  /** True when the mcp_servers row exists and is healthy (OAuth connected). */
  connected: boolean;
  healthStatus: string | null;
}

export async function getGithubMcpInstallStatus(
  input: z.infer<typeof GetStatusSchema>,
): Promise<GithubMcpInstallStatus> {
  const parsed = GetStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { installed: false, orgListingId: null, connected: false, healthStatus: null };
  }

  const { orgSlug, workspaceSlug } = parsed.data;

  let org: { id: string };
  let ws: { id: string };
  try {
    const session = await getSessionOrRedirect();
    org = await resolveOrg(orgSlug);
    ws = await resolveWorkspace(org.id, workspaceSlug);
    await assertOrgMember(org.id, session.user.id);
  } catch {
    return { installed: false, orgListingId: null, connected: false, healthStatus: null };
  }

  const [listing] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ id: schema.pluginInstalledPlugins.id })
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.orgId, org.id),
              eq(schema.pluginInstalledPlugins.workspaceId, ws.id),
              eq(schema.pluginInstalledPlugins.name, GITHUB_MCP_SERVER.name),
              isNull(schema.pluginInstalledPlugins.deletedAt),
            ),
          )
          .limit(1),
      ),
  ).catch((err) => {
    logger.error(
      { err, orgSlug, workspaceSlug },
      "github-mcp: installed-plugin listing read failed — reporting as not-installed",
    );
    return [] as { id: string }[];
  });

  if (!listing) {
    return { installed: false, orgListingId: null, connected: false, healthStatus: null };
  }

  // Check if the mcp_servers row exists and is healthy.
  const [mcpRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            healthStatus: schema.mcpServers.healthStatus,
          })
          .from(schema.mcpServers)
          .where(
            and(
              eq(schema.mcpServers.workspaceId, ws.id),
              eq(schema.mcpServers.orgListingId, listing.id),
              isNull(schema.mcpServers.deletedAt),
            ),
          )
          .limit(1),
      ),
  ).catch((err) => {
    logger.error(
      { err, orgSlug, workspaceSlug },
      "github-mcp: mcp_servers health read failed — reporting as not-installed",
    );
    return [] as { healthStatus: string }[];
  });

  const healthStatus = mcpRow?.healthStatus ?? null;
  const connected = healthStatus === "healthy";

  return {
    installed: true,
    orgListingId: listing.id,
    connected,
    healthStatus,
  };
}
