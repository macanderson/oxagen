import { and, eq, isNull } from "drizzle-orm";
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

  if (enabled) {
    // Load and validate the org listing.
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
