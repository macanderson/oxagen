import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
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

  logger.info({ orgListingId, orgId: ctx.orgId }, "plugin.org.uninstall: ok");
  return { ok: true };
};
