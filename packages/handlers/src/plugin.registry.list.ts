import { or, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (_input, ctx) => {
  const orgId = ctx.orgId;
  let rows: (typeof schema.mcpRegistries.$inferSelect)[];
  try {
    rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.mcpRegistries)
        .where(or(isNull(schema.mcpRegistries.orgId), eq(schema.mcpRegistries.orgId, orgId))),
    );
  } catch (err) {
    logger.error({ err, orgId }, "plugin.registry.list: failed");
    throw err;
  }
  logger.info({ orgId, count: rows.length }, "plugin.registry.list: ok");
  return {
    registries: rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      isDefaultSeed: r.isDefaultSeed,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    })),
  };
};
