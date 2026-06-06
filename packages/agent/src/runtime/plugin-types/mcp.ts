/**
 * MCP plugin-type contributor: yields raw tools for every enabled + healthy
 * workspace-installed MCP server whose org allow-list listing is enabled and not
 * denylisted. The decrypted per-workspace credential is injected into connectMcp.
 *
 * For OAuth listings (authKind === "oauth"), a DbOAuthClientProvider is built so
 * the transport auto-refreshes via the provider's tokens()/saveTokens() interface.
 * On UnauthorizedError (or any auth failure), the credential is flipped to
 * needs_reauth and that server is skipped for this turn.
 */
import { and, eq, isNull } from "drizzle-orm";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { schema, withTenantDb } from "@oxagen/database";
import { getWorkspaceSecret, DbOAuthClientProvider, markCredentialNeedsReauth } from "@oxagen/plugins";
import type { CapabilityContext } from "../../types";
import { connectMcp, materializeMcpTools } from "../../dispatch/mcp-client";
import { registerPluginType, type ContributedRawTool } from "../plugin-type";

async function contributeMcpTools(ctx: CapabilityContext): Promise<ContributedRawTool[]> {
  if (!ctx.workspaceId) return [];

  // Denylisted server names for this org (fetched first; drizzle 0.45.2 doesn't
  // support a correlated subquery inside notInArray for this shape).
  const deniedNames = await withTenantDb(async (tx) => {
    const rows = await tx
      .select({ name: schema.pluginOrgDenylist.serverName })
      .from(schema.pluginOrgDenylist)
      .where(eq(schema.pluginOrgDenylist.orgId, ctx.orgId));
    return rows.map((r) => r.name);
  });

  // Enabled + healthy installs joined to an enabled, non-deleted org listing.
  // Also selects authKind from the listing so we can branch on OAuth vs static.
  const servers = await withTenantDb(async (tx) => {
    const conds = [
      eq(schema.mcpServers.orgId, ctx.orgId),
      eq(schema.mcpServers.workspaceId, ctx.workspaceId),
      eq(schema.mcpServers.enabled, true),
      eq(schema.mcpServers.healthStatus, "healthy"),
      eq(schema.pluginOrgListings.enabled, true),
      isNull(schema.pluginOrgListings.deletedAt),
    ];
    return tx
      .select({
        id: schema.mcpServers.id,
        name: schema.mcpServers.name,
        endpointUrl: schema.mcpServers.endpointUrl,
        authStrategy: schema.mcpServers.authStrategy,
        authConfig: schema.mcpServers.authConfig,
        orgListingId: schema.mcpServers.orgListingId,
        authKind: schema.pluginOrgListings.authKind,
      })
      .from(schema.mcpServers)
      .innerJoin(
        schema.pluginOrgListings,
        eq(schema.mcpServers.orgListingId, schema.pluginOrgListings.id),
      )
      .where(and(...conds));
  });

  const visible = servers.filter((s) => !deniedNames.includes(s.name));

  const out: ContributedRawTool[] = [];
  for (const server of visible) {
    try {
      let client;

      if (server.authKind === "oauth" && server.orgListingId) {
        // OAuth path: build a DbOAuthClientProvider so the transport auto-refreshes.
        const redirectUrl =
          (process.env.APP_URL ?? "") + "/api/v1/mcp/oauth/callback";
        const authProvider = new DbOAuthClientProvider({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgListingId: server.orgListingId,
          redirectUrl,
          // Stable state key for the runtime (not a fresh PKCE flow — just used
          // for the code-verifier store key during token refresh cycles).
          state: "runtime:" + server.orgListingId,
          returnTo: "",
          clientName: "Oxagen",
          now: () => Date.now(),
        });
        client = await connectMcp({
          endpointUrl: server.endpointUrl,
          authStrategy: "none",
          authProvider,
        });
      } else {
        // Static bearer/secret path (Plan 3 behaviour).
        let authStrategy = server.authStrategy as "none" | "bearer" | "header";
        let authConfig = (server.authConfig ?? {}) as Record<string, string>;
        if (server.orgListingId && authStrategy !== "none") {
          const cred = await getWorkspaceSecret({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            orgListingId: server.orgListingId,
          });
          const token = cred?.accessToken ?? cred?.secret ?? null;
          if (token) {
            authStrategy = "bearer";
            authConfig = { token };
          }
        }
        client = await connectMcp({
          endpointUrl: server.endpointUrl,
          authStrategy,
          authConfig,
        });
      }

      const mcpTools = await materializeMcpTools(client, `mcp.${server.id}`);
      for (const [rawKey, rawTool] of Object.entries(mcpTools)) {
        const execute = rawTool.execute;
        if (typeof execute !== "function") continue;
        out.push({
          realName: rawKey,
          description: rawTool.description,
          execute: execute as ContributedRawTool["execute"],
          externalServerId: server.id,
        });
      }
    } catch (err) {
      // Auth failures: flip credential to needs_reauth and skip this server.
      const isAuthError =
        err instanceof UnauthorizedError ||
        (err instanceof Error &&
          (err.message.includes("401") ||
            err.message.includes("Unauthorized") ||
            err.message.includes("unauthorized")));

      if (isAuthError && server.orgListingId) {
        console.warn(
          `[plugin-types/mcp] Auth failure for server ${server.id} (${server.name}); marking needs_reauth`,
        );
        await markCredentialNeedsReauth(ctx.workspaceId, server.orgListingId).catch((e) => {
          console.error("[plugin-types/mcp] Failed to mark needs_reauth:", e);
        });
      } else {
        // Per-server non-auth failure is isolated — log and continue.
        console.error(
          `[plugin-types/mcp] Failed to load MCP tools from server ${server.id} (${server.name}):`,
          err,
        );
      }
    }
  }
  return out;
}

registerPluginType({ type: "mcp_server", contributeTools: contributeMcpTools });

export { contributeMcpTools };
