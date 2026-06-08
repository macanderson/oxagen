import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  let rows: { id: string }[];
  try {
    rows = await withSystemDb((tx) =>
      tx
        .insert(schema.mcpRegistries)
        .values({ orgId: ctx.orgId, name, baseUrl, enabled: true, isDefaultSeed: false })
        .returning({ id: schema.mcpRegistries.id }),
    );
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId, name, baseUrl }, "plugin.registry.add: insert failed");
    throw err;
  }
  const row = rows[0];
  if (!row) throw new Error("registry insert returned no row");
  logger.info({ registryId: row.id, orgId: ctx.orgId, name }, "plugin.registry.add: ok");
  return { registryId: row.id };
};
