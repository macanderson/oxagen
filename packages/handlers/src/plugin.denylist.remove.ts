import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { serverName, pluginType } = input as {
    serverName: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  };

  try {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.pluginOrgDenylist)
        .where(
          and(
            eq(schema.pluginOrgDenylist.orgId, ctx.orgId),
            eq(schema.pluginOrgDenylist.pluginType, pluginType),
            eq(schema.pluginOrgDenylist.serverName, serverName),
          ),
        );
    });
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId, pluginType, serverName }, "plugin.denylist.remove: failed");
    throw err;
  }

  logger.info({ orgId: ctx.orgId, pluginType, serverName }, "plugin.denylist.remove: ok");
  return { ok: true };
};
