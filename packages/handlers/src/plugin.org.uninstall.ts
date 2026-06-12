import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId } = input as { orgListingId: string };

  try {
    await withSystemDb(async (tx) => {
      // Soft-delete the listing (scoped to this org).
      await tx
        .update(schema.pluginOrgListings)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(schema.pluginOrgListings.id, orgListingId),
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
          ),
        );

      // Hard-delete dependent workspace installs so the runtime drops them.
      await tx
        .delete(schema.mcpServers)
        .where(eq(schema.mcpServers.orgListingId, orgListingId));
    });
  } catch (err) {
    logger.error({ err, orgListingId, orgId: ctx.orgId }, "plugin.org.uninstall: failed");
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.uninstalled",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "plugin.org.uninstall",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info({ orgListingId, orgId: ctx.orgId }, "plugin.org.uninstall: ok");
  return { ok: true };
};
