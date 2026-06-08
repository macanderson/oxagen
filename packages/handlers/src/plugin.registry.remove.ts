import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { registryId } = input as { registryId: string };
  let deleted: { id: string }[];
  try {
    deleted = await withSystemDb((tx) =>
      tx
        .delete(schema.mcpRegistries)
        .where(
          and(
            eq(schema.mcpRegistries.id, registryId),
            eq(schema.mcpRegistries.orgId, ctx.orgId),
            eq(schema.mcpRegistries.isDefaultSeed, false),
          ),
        )
        .returning({ id: schema.mcpRegistries.id }),
    );
  } catch (err) {
    logger.error({ err, registryId, orgId: ctx.orgId }, "plugin.registry.remove: failed");
    throw err;
  }
  const ok = deleted.length > 0;
  logger.info({ registryId, orgId: ctx.orgId, ok }, "plugin.registry.remove: ok");
  return { ok };
};
