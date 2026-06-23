/**
 * MCP plugin-type contributor: yields raw tools for every enabled + healthy
 * workspace-installed MCP server whose installed_plugins row is enabled and not
 * soft-deleted. The decrypted per-workspace credential is injected into connectMcp.
 *
 * For OAuth listings (authKind === "oauth"), a DbOAuthClientProvider is built so
 * the transport auto-refreshes via the provider's tokens()/saveTokens() interface.
 * On UnauthorizedError (or any auth failure), the credential is flipped to
 * needs_reauth and that server is skipped for this turn.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import pino from "pino";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { schema, withTenantDb } from "@oxagen/database";
import { getWorkspaceSecret, DbOAuthClientProvider, markCredentialNeedsReauth } from "@oxagen/plugins";
import type { CapabilityContext } from "../../types";
import { connectMcp, materializeMcpTools } from "../../dispatch/mcp-client";
import { registerPluginType, type ContributedRawTool, type PluginContributeOptions } from "../plugin-type";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.plugin-types.mcp" } });

async function contributeMcpTools(ctx: CapabilityContext, options?: PluginContributeOptions): Promise<ContributedRawTool[]> {
  if (!ctx.workspaceId) return [];

  // Enabled + healthy installs joined to the installed_plugins row (workspace-scoped).
  // Also selects authKind from the installed plugin so we can branch on OAuth vs static.
  const workspaceId = ctx.workspaceId;
  const servers = await withTenantDb(async (tx) => {
    // Base conditions — always applied.
    const baseConds = [
      eq(schema.mcpServers.orgId, ctx.orgId),
      eq(schema.mcpServers.workspaceId, workspaceId),
      eq(schema.mcpServers.enabled, true),
      // Soft-deleted servers (OXA-820) stop registering tools but keep their
      // descriptor snapshots for replay.
      isNull(schema.mcpServers.deletedAt),
      // Accept "healthy" (probed OK, e.g. after OAuth) AND "unknown" (just enabled
      // via the toggle/secret path — only the OAuth callback ever sets "healthy", so
      // requiring "healthy" silently hid every secret-auth server from the agent).
      // The live connectMcp() + listTools() below is the real health gate: a server
      // that can't connect is skipped gracefully. Genuinely "unhealthy" servers are
      // still excluded.
      // Note: or() is used here so that inArray() remains exclusively the per-turn
      // serverAllowlist filter, keeping spy-based allowlist tests unambiguous.
      or(
        eq(schema.mcpServers.healthStatus, "healthy"),
        eq(schema.mcpServers.healthStatus, "unknown"),
      ),
      eq(schema.pluginInstalledPlugins.enabled, true),
      isNull(schema.pluginInstalledPlugins.deletedAt),
    ] as const;
    // Per-turn server allowlist: when the user has toggled specific servers
    // active in the chat composer, only load those servers' tools.
    const allowlistCond =
      options?.serverAllowlist && options.serverAllowlist.size > 0
        ? inArray(schema.mcpServers.publicId, [...options.serverAllowlist])
        : undefined;
    return tx
      .select({
        id: schema.mcpServers.id,
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        endpointUrl: schema.mcpServers.endpointUrl,
        authStrategy: schema.mcpServers.authStrategy,
        authConfig: schema.mcpServers.authConfig,
        orgListingId: schema.mcpServers.orgListingId,
        authKind: schema.pluginInstalledPlugins.authKind,
      })
      .from(schema.mcpServers)
      .innerJoin(
        schema.pluginInstalledPlugins,
        eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
      )
      .where(and(...baseConds, allowlistCond));
  });

  const visible = servers;

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
        logger.warn(
          { serverId: server.id, serverName: server.name },
          "auth failure for MCP server; marking needs_reauth",
        );
        await markCredentialNeedsReauth(ctx.workspaceId, server.orgListingId).catch((e) => {
          logger.error({ serverId: server.id, err: e }, "failed to mark needs_reauth");
        });
      } else {
        // Per-server non-auth failure is isolated — log and continue.
        logger.error(
          { serverId: server.id, serverName: server.name, err },
          "failed to load MCP tools from server",
        );
      }
    }
  }
  return out;
}

registerPluginType({ type: "mcp_server", contributeTools: contributeMcpTools });

export { contributeMcpTools };
