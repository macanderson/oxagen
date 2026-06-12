import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

/** Map authKind from the org listing to the authStrategy expected by connectMcp. */
function mapAuthStrategy(
  authKind: string,
): "none" | "bearer" | "header" {
  if (authKind === "none") return "none";
  if (authKind === "oauth") return "bearer";
  // "secret" — use bearer (API key in Authorization header is the most common pattern)
  return "bearer";
}

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as { orgListingId: string; enabled: boolean };

  if (!ctx.workspaceId) {
    throw new Error("[plugin.workspace.set_enabled] workspaceId is required (scoped capability)");
  }

  // Load the org listing upfront so both enable and disable paths can guard on
  // plugin_type. This is needed because capability packs are org-level only in
  // Phase 1 — workspace-level enable/disable arrives in Phase 2.
  const listing = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.pluginOrgListings)
      .where(
        and(
          eq(schema.pluginOrgListings.id, orgListingId),
          eq(schema.pluginOrgListings.orgId, ctx.orgId),
          isNull(schema.pluginOrgListings.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    throw new Error(
      `[plugin.workspace.set_enabled] Org listing not found or deleted: ${orgListingId}`,
    );
  }

  // Guard: capability packs cannot be workspace-toggled in Phase 1.
  if (listing.pluginType === "capability") {
    throw new Error(
      "[plugin.workspace.set_enabled] Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2. " +
        "Capability packs are org-level — use plugin.org.set_enabled instead.",
    );
  }

  if (enabled) {
    if (!listing.enabled) {
      throw new Error(
        `[plugin.workspace.set_enabled] Org listing "${listing.name}" is disabled at the org level.`,
      );
    }
    if (!listing.endpointUrl) {
      throw new Error(
        `[plugin.workspace.set_enabled] Org listing "${listing.name}" has no endpoint URL.`,
      );
    }

    // Check the denylist.
    const denied = await withSystemDb(async (tx) => {
      const [row] = await tx
        .select({ id: schema.pluginOrgDenylist.id })
        .from(schema.pluginOrgDenylist)
        .where(
          and(
            eq(schema.pluginOrgDenylist.orgId, ctx.orgId),
            eq(schema.pluginOrgDenylist.pluginType, listing.pluginType),
            eq(schema.pluginOrgDenylist.serverName, listing.name),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (denied) {
      throw new Error(
        `[plugin.workspace.set_enabled] Server "${listing.name}" is on the org denylist.`,
      );
    }

    // Upsert the workspace install row.
    const authStrategy = mapAuthStrategy(listing.authKind);

    const row = await withTenantDb(async (tx) => {
      const [inserted] = await tx
        .insert(schema.mcpServers)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgListingId,
          name: listing.name,
          transportType: listing.transport ?? "sse",
          endpointUrl: listing.endpointUrl!,
          authStrategy,
          authConfig: {},
          healthStatus: "unknown",
          enabled: true,
          discoveredTools: [],
        })
        .onConflictDoUpdate({
          target: [schema.mcpServers.workspaceId, schema.mcpServers.orgListingId],
          // mcp_servers_ws_listing_uniq is a PARTIAL unique index; ON CONFLICT
          // only matches it when the inference clause carries the same predicate.
          targetWhere: sql`org_listing_id IS NOT NULL`,
          set: {
            enabled: true,
            healthStatus: "unknown",
            updatedAt: new Date(),
          },
        })
        .returning({
          publicId: schema.mcpServers.publicId,
        });
      return inserted ?? null;
    });

    logger.info(
      { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, workspaceServerId: row?.publicId ?? null },
      "plugin.workspace.set_enabled: enabled",
    );
    return { workspaceServerId: row?.publicId ?? null };
  } else {
    // Disable: set enabled=false on the workspace install row.
    try {
      await withTenantDb(async (tx) => {
        await tx
          .update(schema.mcpServers)
          .set({ enabled: false })
          .where(
            and(
              eq(schema.mcpServers.workspaceId, ctx.workspaceId),
              eq(schema.mcpServers.orgListingId, orgListingId),
            ),
          );
      });
    } catch (err) {
      logger.error(
        { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "plugin.workspace.set_enabled: disable failed",
      );
      throw err;
    }

    logger.info(
      { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "plugin.workspace.set_enabled: disabled",
    );
    return { workspaceServerId: null };
  }
};
