import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const {
    pluginType,
    serverName,
    reason,
  } = input as {
    pluginType: "mcp_server" | "integration" | "content_tool";
    serverName: string;
    reason?: string;
  };

  try {
    await withSystemDb(async (tx) => {
      // Insert denylist row (idempotent).
      await tx
        .insert(schema.pluginOrgDenylist)
        .values({
          orgId: ctx.orgId,
          pluginType,
          serverName,
          reason: reason ?? null,
        })
        .onConflictDoNothing();

      // Cascade: disable matching org listings.
      await tx
        .update(schema.pluginOrgListings)
        .set({ enabled: false })
        .where(
          and(
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
            eq(schema.pluginOrgListings.pluginType, pluginType),
            eq(schema.pluginOrgListings.name, serverName),
          ),
        );

      // Cascade: delete dependent workspace installs for any matching listing
      // (the subquery approach — fetch listing ids first, then delete installs).
      const matchingListings = await tx
        .select({ id: schema.pluginOrgListings.id })
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
            eq(schema.pluginOrgListings.pluginType, pluginType),
            eq(schema.pluginOrgListings.name, serverName),
          ),
        );

      for (const listing of matchingListings) {
        await tx
          .delete(schema.mcpServers)
          .where(eq(schema.mcpServers.orgListingId, listing.id));
      }
    });
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId, pluginType, serverName }, "plugin.denylist.add: failed");
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.denylist_added",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "plugin.denylist.add",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info({ orgId: ctx.orgId, pluginType, serverName }, "plugin.denylist.add: ok");
  return { ok: true };
};
