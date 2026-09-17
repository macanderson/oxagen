// The MCP servers a turn loads tools from. The runtime contributor
// (plugin-types/mcp.ts) and get_agent_toolbelt (packages/handlers) both select
// through this one query, so the belt lists exactly the servers whose tools
// the model can be given.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";

interface McpServerFilter {
  orgId: string;
  workspaceId: string;
  /** Public ids the chat composer toggled active; empty or absent loads every server. */
  serverAllowlist?: ReadonlySet<string>;
}

/**
 * An enabled, not soft-deleted server whose `plugin.installed_plugins` row is
 * enabled and not soft-deleted, with health `healthy` or `unknown`. A server
 * with no listing (`org_listing_id` NULL) has no install row and is not
 * loaded; neither is one whose install an org admin turned off.
 */
export function selectMaterializableMcpServers(
  tx: Tx,
  filter: McpServerFilter,
) {
  const allowlist =
    filter.serverAllowlist && filter.serverAllowlist.size > 0
      ? inArray(schema.mcpServers.publicId, [...filter.serverAllowlist])
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
      discoveredTools: schema.mcpServers.discoveredTools,
      authKind: schema.pluginInstalledPlugins.authKind,
    })
    .from(schema.mcpServers)
    .innerJoin(
      schema.pluginInstalledPlugins,
      eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
    )
    .where(
      and(
        eq(schema.mcpServers.orgId, filter.orgId),
        eq(schema.mcpServers.workspaceId, filter.workspaceId),
        eq(schema.mcpServers.enabled, true),
        // Soft-deleted servers stop registering tools but keep their
        // descriptor snapshots for replay.
        isNull(schema.mcpServers.deletedAt),
        // "unknown" is the state the toggle/secret path leaves (only the OAuth
        // callback sets "healthy"); the live connect in the contributor is the
        // health gate for it. "degraded" and "unreachable" are excluded.
        // or(eq, eq) keeps inArray for the allowlist alone, which
        // plugin-types/mcp.test.ts asserts against.
        or(
          eq(schema.mcpServers.healthStatus, "healthy"),
          eq(schema.mcpServers.healthStatus, "unknown"),
        ),
        eq(schema.pluginInstalledPlugins.enabled, true),
        isNull(schema.pluginInstalledPlugins.deletedAt),
        allowlist,
      ),
    );
}
