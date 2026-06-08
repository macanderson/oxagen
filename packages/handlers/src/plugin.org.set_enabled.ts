import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as { orgListingId: string; enabled: boolean };

  try {
    await withSystemDb(async (tx) => {
      await tx
        .update(schema.pluginOrgListings)
        .set({ enabled })
        .where(
          and(
            eq(schema.pluginOrgListings.id, orgListingId),
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
          ),
        );
    });
  } catch (err) {
    logger.error({ err, orgListingId, orgId: ctx.orgId, enabled }, "plugin.org.set_enabled: failed");
    throw err;
  }

  logger.info({ orgListingId, orgId: ctx.orgId, enabled }, "plugin.org.set_enabled: ok");
  return { ok: true };
};
