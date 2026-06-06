/**
 * MCP plugin-type contributor: yields raw tools for every enabled + healthy
 * workspace-installed MCP server whose org allow-list listing is enabled and not
 * denylisted. The decrypted per-workspace credential is injected into connectMcp.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { getWorkspaceSecret } from "@oxagen/plugins";
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
      let authStrategy = server.authStrategy as "none" | "bearer" | "header";
      let authConfig = (server.authConfig ?? {}) as Record<string, string>;
      // Inject the decrypted per-workspace credential when one exists.
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
      const client = await connectMcp({
        endpointUrl: server.endpointUrl,
        authStrategy,
        authConfig,
      });
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
      // Per-server failure is isolated — log and continue.
      console.error(
        `[plugin-types/mcp] Failed to load MCP tools from server ${server.id} (${server.name}):`,
        err,
      );
    }
  }
  return out;
}

registerPluginType({ type: "mcp_server", contributeTools: contributeMcpTools });

export { contributeMcpTools };
