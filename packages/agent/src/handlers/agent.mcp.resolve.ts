/**
 * resolve_mcp_servers handler — returns the active workspace's enabled MCP
 * servers with connection details AND their per-workspace credentials, resolved
 * and decrypted SERVER-SIDE, for a first-party client (the Oxagen CLI) to
 * connect directly.
 *
 * This mirrors the credential-resolution path of the runtime plugin-type
 * contributor (../runtime/plugin-types/mcp.ts) so the CLI sees the SAME set of
 * usable servers the platform agent would — capability parity — but returns the
 * resolved token/headers instead of opening a client. Security-relevant notes:
 *
 *   - Only the FINAL usable secret leaves the server: the bearer/access token or
 *     auth headers. Ciphertext, KMS keys, and (for oauth) the refresh token are
 *     never included in the response.
 *   - The capability is deny-by-default, `sensitivity: "high"`, and gated to
 *     workspace members already entitled to use these servers.
 *   - Auto-refresh of an EXPIRED oauth access token is NOT performed here (the
 *     runtime does it lazily via the transport's auth provider). An oauth server
 *     whose stored token is absent/stale is returned with `needsReauth: true`.
 *     TODO: resolve a fresh oauth access token server-side (or move
 *     to a full server-side call-proxy) so expired-token servers self-heal.
 */
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { getWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityContext } from "../types";
import type {
  AgentMcpResolveInput,
  AgentMcpResolveOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.resolve";
import { decryptMcpAuthConfig } from "../runtime/mcp-server-auth-crypto";

export type { AgentMcpResolveInput, AgentMcpResolveOutput };

type ResolvedServer = AgentMcpResolveOutput["servers"][number];

export async function agentMcpResolveHandler(
  _input: AgentMcpResolveInput,
  ctx: CapabilityContext,
): Promise<AgentMcpResolveOutput> {
  if (!ctx.workspaceId) return { servers: [] };
  const workspaceId = ctx.workspaceId;

  // Enabled + not-deleted installs joined to their installed_plugins row, the
  // same shape the runtime contributor selects (innerJoin on org_listing_id).
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        endpointUrl: schema.mcpServers.endpointUrl,
        transportType: schema.mcpServers.transportType,
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
      .where(
        and(
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, workspaceId),
          eq(schema.mcpServers.enabled, true),
          isNull(schema.mcpServers.deletedAt),
          eq(schema.pluginInstalledPlugins.enabled, true),
          isNull(schema.pluginInstalledPlugins.deletedAt),
        ),
      ),
  );

  const servers: ResolvedServer[] = [];
  for (const row of rows) {
    const transportType =
      row.transportType === "stdio" ? "stdio" : "streamable-http";
    const declaredStrategy = row.authStrategy as "none" | "bearer" | "header";
    const authKind = ((): "oauth" | "secret" | "none" => {
      if (row.authKind === "oauth") return "oauth";
      if (row.authKind === "secret") return "secret";
      return "none";
    })();

    let token: string | null = null;
    let headers: Record<string, string> | null = null;
    let needsReauth = false;

    // Static auth_config (envelope-encrypted at rest) — may carry a bearer token
    // or header k/v pairs for servers that don't route through mcp.credentials.
    const staticConfig = await decryptMcpAuthConfig(row.authConfig);

    if (
      row.orgListingId &&
      (declaredStrategy !== "none" || authKind !== "none")
    ) {
      // Preferred source: the workspace credential (mcp.credentials), used for
      // both secret and oauth installs.
      const cred = await getWorkspaceSecret({
        orgId: ctx.orgId,
        workspaceId,
        orgListingId: row.orgListingId,
      });
      token = cred?.accessToken ?? cred?.secret ?? null;
      if (!token) {
        // Fall back to the static auth_config (legacy/plaintext or header auth).
        token =
          typeof staticConfig.token === "string" ? staticConfig.token : null;
        if (!token && Object.keys(staticConfig).length > 0) {
          headers = staticConfig;
        }
      }
      needsReauth =
        !token &&
        !headers &&
        (authKind === "oauth" || declaredStrategy !== "none");
      if (cred?.status && cred.status !== "active") needsReauth = true;
    } else if (
      declaredStrategy !== "none" &&
      Object.keys(staticConfig).length > 0
    ) {
      // Plugin-less static server: bearer token or header map in auth_config.
      if (typeof staticConfig.token === "string") token = staticConfig.token;
      else headers = staticConfig;
    }

    const authStrategy: "none" | "bearer" | "header" = token
      ? "bearer"
      : headers
        ? "header"
        : "none";

    servers.push({
      publicId: row.publicId,
      name: row.name,
      transportType,
      endpointUrl: row.endpointUrl,
      authStrategy,
      authKind,
      token,
      headers,
      needsReauth,
    });
  }

  return { servers };
}
